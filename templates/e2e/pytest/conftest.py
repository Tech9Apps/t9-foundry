"""
pytest conftest — QA Harness integration for e2e tests.

This file is the pytest root config. It wires up:
  - Layer 5 production guard (validates BASE_URL before any test runs)
  - Session-scoped DataFactory cleanup (runs after the full test suite)
  - Common fixtures shared across all test files

Add your own project-specific fixtures below the existing ones.
"""

import os
import sys
import pytest

# Ensure the support package is importable when pytest runs from this directory
sys.path.insert(0, os.path.dirname(__file__))

from support.prod_guard import validate_not_production
from support.data_factory import DataFactory


# ── Session startup — production guard ───────────────────────────────────────

def pytest_sessionstart(session: pytest.Session) -> None:
    """Validate the test environment before any test runs (Layer 5 guard)."""
    base_url = os.environ.get("BASE_URL", "")
    if not base_url:
        raise RuntimeError(
            "BASE_URL is not set. Copy .env.test.example to .env.test, "
            "fill in your staging URL, then run: export $(cat .env.test | xargs)"
        )
    validate_not_production(base_url)
    print(f"\n✓ QA Harness — test environment: {base_url}\n")


# ── Session teardown — data cleanup ──────────────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def _cleanup_all_test_data():
    """Clean up all DataFactory-created entities after the full test run."""
    yield
    DataFactory.cleanup_all()


# ── Shared fixtures ───────────────────────────────────────────────────────────

@pytest.fixture
def base_url() -> str:
    return os.environ["BASE_URL"]


@pytest.fixture
def test_user():
    """Create a test user via the API; cleaned up automatically after the run."""
    return DataFactory.create_user()


# Add project-specific fixtures below:
#
# @pytest.fixture
# def test_order(test_user):
#     return DataFactory.create_order(user_id=test_user["id"])
