"""
Command-line interface for the RAG pipeline.
All the real logic lives in rag_core.py — this file just runs an interactive loop.

Usage: python rag_pipeline.py [docs_folder]   (defaults to "docs")
"""

import sys
from log_config import setup_logging
from rag_core import RagEngine
from corpora import all_corpora


def main():
    setup_logging()
    # Optional folder argument; defaults to the "docs" directory.
    docs_dir = sys.argv[1] if len(sys.argv) > 1 else "docs"

    # CLI uses the first configured corpus.
    corpus_id = all_corpora()[0]["id"]
    engine = RagEngine(corpus_id, docs_dir)

    print("RAG pipeline ready. Type your question (or 'quit' to exit).\n")
    while True:
        question = input("Your question: ").strip()
        if question.lower() in ("quit", "exit", "q"):
            break
        if not question:
            continue

        result = engine.answer(question)

        if result["sources"]:
            print("\nRetrieved chunks:")
            for chunk in result["sources"]:
                preview = chunk["text"][:70].replace("\n", " ")
                print(f"  [{chunk['source']}, page {chunk['page_number']}] {preview}...")

        print(f"\nAnswer:\n{result['answer']}\n")
        print("-" * 60 + "\n")


if __name__ == "__main__":
    main()