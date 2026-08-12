"""
Central logging setup. Call setup_logging() once at startup (backend, CLI, sync).
Log level is controlled by the LOG_LEVEL env var (default INFO).
"""

import os
import sys
import logging

_CONFIGURED = False


def setup_logging() -> None:
    """Configure a single, consistently-formatted log handler. Idempotent."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    level = os.getenv("LOG_LEVEL", "INFO").upper()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s | %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(level)
    _CONFIGURED = True