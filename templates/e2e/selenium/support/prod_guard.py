import os
import re
from typing import List, Optional

# Looks like a bare production host (two-label domain), excluding common non-prod prefixes.
_SUSPICIOUS_URL = re.compile(
    r"^https?://(?!staging\.|test\.|dev\.|qa\.|localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z]{2,}(?:/|$)",
    re.IGNORECASE,
)


def _protection_settings() -> dict:
    """productionProtection block from qa-config.json ({} if unavailable)."""
    try:
        from .qa_config_loader import load_qa_config

        return load_qa_config().get("productionProtection", {}) or {}
    except Exception:
        return {}


def validate_not_production(base_url: str, patterns: Optional[List[str]] = None) -> None:
    """Layer 5 production guard — raises RuntimeError if base_url matches any
    production URL pattern. Called in conftest.py before any test runs.

    Args:
        base_url: The test environment URL to validate.
        patterns: List of regex patterns identifying production URLs.
                  If None, patterns are loaded from qa-config.json automatically.

    Guard mode: with QA_AUTONOMOUS=1 (unattended runs) or
    productionProtection.mode == "enforce", a suspicious-looking URL raises
    instead of only warning — a warning nobody reads is not a guard.
    """
    if not base_url:
        raise RuntimeError(
            "BASE_URL is not set. Add it to .env.test or export it in your shell."
        )

    protection = _protection_settings()

    if patterns is None:
        patterns = protection.get("prodUrlPatterns", [])

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

    # Heuristic check — an additional layer that still runs once real patterns exist.
    if protection.get("blockOnSuspiciousUrls", True) is False:
        return
    for allowed in protection.get("allowedUrlPatterns", []) or []:
        try:
            if re.search(allowed, base_url):
                return
        except re.error:
            continue  # an invalid allow-pattern never exempts anything

    if _SUSPICIOUS_URL.search(base_url):
        enforce = os.environ.get("QA_AUTONOMOUS") == "1" or protection.get("mode") == "enforce"
        if enforce:
            raise RuntimeError(
                f"BLOCKED: BASE_URL '{base_url}' looks like a production URL and guard mode is "
                "'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode).\n"
                "Set BASE_URL to your staging URL, or add a regex for this URL to "
                "productionProtection.allowedUrlPatterns in qa-config.json if it is safe."
            )
        print(
            f"WARNING: BASE_URL '{base_url}' may be a production URL. "
            "Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking."
        )
