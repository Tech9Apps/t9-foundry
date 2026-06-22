"""
pytest conftest — QA Harness integration for Selenium e2e tests.

Wires up:
  - Layer 5 production guard (validates BASE_URL before any test runs)
  - Chrome WebDriver session fixture (one browser per test function)
  - Session-scoped DataFactory cleanup after the full suite
"""

import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(__file__))

from support.prod_guard import validate_not_production
from support.data_factory import DataFactory

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.chrome.service import Service
    from webdriver_manager.chrome import ChromeDriverManager
except ImportError as exc:
    raise ImportError(
        "Selenium dependencies missing. Run: pip install selenium webdriver-manager"
    ) from exc


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


# ── Browser fixture ───────────────────────────────────────────────────────────

@pytest.fixture
def browser():
    """Provide a Chrome WebDriver instance for each test; quit after the test."""
    options = ChromeOptions()
    if os.environ.get("CI"):
        options.add_argument("--headless")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")

    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=options,
    )
    driver.implicitly_wait(10)
    yield driver
    driver.quit()


# ── Shared fixtures ───────────────────────────────────────────────────────────

@pytest.fixture
def base_url() -> str:
    return os.environ["BASE_URL"]


@pytest.fixture
def test_user():
    """Create a test user via the API; cleaned up automatically after the run."""
    return DataFactory.create_user()
