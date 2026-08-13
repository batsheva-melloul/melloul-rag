"""
LLM provider abstraction.

The rest of the app talks ONLY to this module — it never imports a vendor SDK
directly. To switch providers (Gemini -> Azure OpenAI -> Claude ...), add a new
Provider class here and change the LLM_PROVIDER environment variable. No other
file needs to change.

A Provider exposes two operations:
  - embed(texts)              -> list of embedding vectors
  - generate(system, messages) -> answer text

"messages" is a vendor-neutral list of {"role": "user" | "assistant", "text": str}.
Each provider translates that into its own format internally.
"""

import os
import time
import logging
import warnings
import urllib3
from abc import ABC, abstractmethod
from dotenv import load_dotenv

# Load .env early so the SSL flag is available at import time.
load_dotenv()

logger = logging.getLogger("rag.llm")

warnings.filterwarnings("ignore")

# SSL verification:
# Corporate networks that do SSL inspection break certificate verification, so on
# that network we disable it via DISABLE_SSL_VERIFY=true. In the cloud DO NOT set it
# — proper SSL verification stays ON (the secure default).
if os.getenv("DISABLE_SSL_VERIFY", "false").lower() == "true":
    import httpx
    _original_init = httpx.Client.__init__
    def _no_ssl_verify_init(self, *args, **kwargs):
        kwargs["verify"] = False
        _original_init(self, *args, **kwargs)
    httpx.Client.__init__ = _no_ssl_verify_init
    urllib3.disable_warnings()
    logger.warning("SSL verification DISABLED (DISABLE_SSL_VERIFY=true) — corporate-network mode")


def _is_daily_quota_error(error) -> bool:
    """
    Distinguish a DAILY-quota exhaustion (429 RESOURCE_EXHAUSTED — retrying is
    pointless, the cap resets only after ~24h) from a transient rate limit
    (429 too-many-requests — worth retrying). On the free tier the daily cap is
    hit fast; failing fast here avoids wasting minutes on doomed retries.
    """
    text = str(getattr(error, "message", "") or "") + str(error)
    return "RESOURCE_EXHAUSTED" in text or "exceeded your current quota" in text


# ---------------------------------------------------------------------------
# Provider interface
# ---------------------------------------------------------------------------

class LLMProvider(ABC):
    """Common interface every provider must implement."""

    # Name of the embedding model — used to namespace the vector store so that
    # changing providers/models starts a fresh, separate index.
    embed_model: str

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text (single API request)."""

    @abstractmethod
    def generate(self, system: str, messages: list[dict]) -> str:
        """Return the model's answer given a system prompt and chat messages."""


# ---------------------------------------------------------------------------
# Gemini provider (Google)
# ---------------------------------------------------------------------------

class GeminiProvider(LLMProvider):
    """Google Gemini implementation (free tier friendly)."""

    def __init__(self):
        from google import genai  # imported here so other providers don't need it
        self._genai = genai

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY not found. Add it to your .env file.")

        self._client = genai.Client(api_key=api_key)
        self.embed_model = os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-001")
        self.chat_model = os.getenv("GEMINI_CHAT_MODEL", "gemini-2.5-flash")

    def embed(self, texts: list[str]) -> list[list[float]]:
        # Retry on rate limit (429), but give up after a bounded number of tries
        # so an exhausted DAILY quota doesn't loop forever.
        max_attempts = 6
        for attempt in range(1, max_attempts + 1):
            try:
                result = self._client.models.embed_content(
                    model=self.embed_model,
                    contents=texts,
                )
                return [e.values for e in result.embeddings]
            except self._genai.errors.ClientError as error:
                # Daily cap exhausted — no point retrying, fail fast.
                if error.code == 429 and _is_daily_quota_error(error):
                    raise RuntimeError(
                        "Gemini daily quota exhausted (free tier). Try again "
                        "tomorrow or move to a paid tier."
                    ) from error
                if error.code == 429 and attempt < max_attempts:
                    logger.warning("Embedding rate-limited (429); retry %d/%d in 30s",
                                   attempt, max_attempts)
                    time.sleep(30)
                else:
                    raise
        # Reached only if every attempt was rate-limited — likely the daily cap.
        raise RuntimeError(
            "Embedding failed: rate limit persisted after several retries "
            "(the daily quota may be exhausted). Try again later or use a paid tier."
        )

    def generate(self, system: str, messages: list[dict]) -> str:
        # Convert neutral messages -> Gemini "contents" (assistant -> model).
        contents = [
            {
                "role": "user" if m["role"] == "user" else "model",
                "parts": [{"text": m["text"]}],
            }
            for m in messages
        ]
        config = self._genai.types.GenerateContentConfig(system_instruction=system)

        max_attempts = 5
        for attempt in range(1, max_attempts + 1):
            try:
                response = self._client.models.generate_content(
                    model=self.chat_model,
                    contents=contents,
                    config=config,
                )
                return response.text
            except (self._genai.errors.ServerError,
                    self._genai.errors.ClientError) as error:
                # Daily cap exhausted — no point retrying, fail fast.
                if error.code == 429 and _is_daily_quota_error(error):
                    raise RuntimeError(
                        "Gemini daily quota exhausted (free tier). Try again "
                        "tomorrow or move to a paid tier."
                    ) from error
                # 503 = overloaded, 429 = transient rate limit — both worth retrying.
                if error.code in (429, 503) and attempt < max_attempts:
                    wait = 10 * attempt
                    logger.warning("Model busy (%s); retry %d/%d in %ds",
                                   error.code, attempt, max_attempts, wait)
                    time.sleep(wait)
                else:
                    raise
        return "Sorry, the model is currently unavailable. Please try again later."


# ---------------------------------------------------------------------------
# Azure OpenAI provider
# ---------------------------------------------------------------------------

class AzureOpenAIProvider(LLMProvider):
    """
    Azure OpenAI implementation via the REST API (raw httpx — no extra SDK).
    Auth is the resource api-key; each model is addressed by its DEPLOYMENT name.

    gpt-5 family quirks handled here: uses `max_completion_tokens` (not
    `max_tokens`), and does NOT accept a custom `temperature` (omit it).
    """

    # How many completion tokens the chat model may produce. gpt-5 is a reasoning
    # model — the hidden reasoning tokens are counted here TOO, so a low cap can be
    # fully consumed by reasoning on a complex question, leaving an EMPTY answer.
    # Keep this generous (billing is per token actually generated, not per the cap).
    MAX_COMPLETION_TOKENS = 8000

    def __init__(self):
        self.endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "").rstrip("/")
        self.api_key = os.getenv("AZURE_OPENAI_API_KEY")
        self.api_version = os.getenv("AZURE_OPENAI_API_VERSION", "2024-10-21")
        self.chat_deployment = os.getenv("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-5-mini")
        self.embed_deployment = os.getenv("AZURE_OPENAI_EMBED_DEPLOYMENT",
                                          "text-embedding-3-small")
        # The embedding model name namespaces the Chroma collection, so switching
        # from Gemini to this triggers a clean re-index (different vectors/dims).
        self.embed_model = self.embed_deployment

        if not self.endpoint or not self.api_key:
            raise RuntimeError(
                "Azure OpenAI: set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env"
            )

        import httpx
        # A persistent client; the SSL monkeypatch above (if active) forces
        # verify=False for the corporate network, else verification stays ON.
        self._client = httpx.Client(timeout=60)
        self._httpx = httpx

    def _url(self, deployment: str, path: str) -> str:
        return (f"{self.endpoint}/openai/deployments/{deployment}/{path}"
                f"?api-version={self.api_version}")

    def _post(self, deployment: str, path: str, body: dict) -> dict:
        """POST with bounded retry on transient 429/503; fail fast on daily quota."""
        headers = {"api-key": self.api_key, "Content-Type": "application/json"}
        url = self._url(deployment, path)
        max_attempts = 5
        for attempt in range(1, max_attempts + 1):
            try:
                response = self._client.post(url, headers=headers, json=body)
            except self._httpx.TransportError as error:
                # Transient network error (timeout, connection reset) — retry.
                if attempt < max_attempts:
                    wait = 10 * attempt
                    logger.warning("Azure network error (%s); retry %d/%d in %ds",
                                   type(error).__name__, attempt, max_attempts, wait)
                    time.sleep(wait)
                    continue
                raise RuntimeError(
                    f"Azure OpenAI {path} failed after network errors: {error}"
                ) from error
            if response.status_code == 200:
                return response.json()
            if response.status_code in (429, 503) and attempt < max_attempts:
                wait = 10 * attempt
                logger.warning("Azure busy (%s); retry %d/%d in %ds",
                               response.status_code, attempt, max_attempts, wait)
                time.sleep(wait)
                continue
            # Non-retryable (or out of retries): surface a clear error.
            raise RuntimeError(
                f"Azure OpenAI {path} failed (HTTP {response.status_code}): "
                f"{response.text[:300]}"
            )
        raise RuntimeError(f"Azure OpenAI {path} failed after {max_attempts} retries.")

    def embed(self, texts: list[str]) -> list[list[float]]:
        data = self._post(self.embed_deployment, "embeddings", {"input": texts})
        # Sort by index to guarantee the order matches the input list.
        items = sorted(data["data"], key=lambda d: d["index"])
        return [item["embedding"] for item in items]

    def generate(self, system: str, messages: list[dict]) -> str:
        # Neutral messages -> OpenAI chat format (system first, then the turns).
        contents = [{"role": "system", "content": system}]
        for m in messages:
            role = "assistant" if m["role"] == "assistant" else "user"
            contents.append({"role": role, "content": m["text"]})

        body = {
            "messages": contents,
            "max_completion_tokens": self.MAX_COMPLETION_TOKENS,
            # NOTE: gpt-5 accepts only the default temperature — do NOT send one.
        }
        data = self._post(self.chat_deployment, "chat/completions", body)
        choice = data["choices"][0]
        content = choice["message"].get("content")
        if not content:
            # gpt-5 can spend the whole token budget on hidden reasoning and return
            # no visible text (finish_reason "length"). Log it so it's diagnosable.
            logger.warning(
                "Empty completion (finish_reason=%s) — reasoning may have used the "
                "entire max_completion_tokens budget", choice.get("finish_reason"),
            )
        return content or ""


# ---------------------------------------------------------------------------
# Factory — pick the provider from the LLM_PROVIDER environment variable
# ---------------------------------------------------------------------------

# Register new providers here as they are added (e.g. "claude").
_PROVIDERS = {
    "gemini": GeminiProvider,
    "azure": AzureOpenAIProvider,
}


def get_provider() -> LLMProvider:
    """Create the provider selected by the LLM_PROVIDER env var (default: gemini)."""
    name = os.getenv("LLM_PROVIDER", "gemini").lower()
    if name not in _PROVIDERS:
        raise ValueError(
            f"Unknown LLM_PROVIDER '{name}'. Available: {list(_PROVIDERS)}"
        )
    return _PROVIDERS[name]()