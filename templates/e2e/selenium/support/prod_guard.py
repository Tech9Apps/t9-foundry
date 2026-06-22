import re
from typing import List, Optional


def validate_not_production(base_url: str, patterns: Optional[List[str]] = None) -> None:
    """Layer 5 production guard — raises RuntimeError if base_url matches any
    production URL pattern. Called in conftest.py before any test runs.

    Args:
        base_url: The test environment URL to validate.
        patterns: List of regex patterns identifying production URLs.
                  If None, patterns are loaded from qa-config.json automatically.
    """
    if not base_url:
        raise RuntimeError(
            "BASE_URL is not set. Add it to .env.test or export it in your shell."
        )

    if patterns is None:
        from .qa_config_loader import load_qa_config
        qa = load_qa_config()
        patterns = qa.get("productionProtection", {}).get("prodUrlPatterns", [])

    for pattern in patterns:
        try:
            if re.search(pattern, base_url):
                raise RuntimeError(
                    f"BLOCKED: BASE_URL '{base_url}' matches a production pattern: {pattern}\n"
                    "Tests must never run against production. "
                    "Update BASE_URL in .env.test to point at your staging environment."
                )
        except re.error:
            print(f"WARNING: Skipping invalid production URL pattern: {pattern}")
