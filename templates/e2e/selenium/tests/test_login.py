"""
Example e2e test — Login flow (Selenium + pytest)

Uses the `browser` and `base_url` fixtures from conftest.py.
Replace the CSS/data-testid selectors with your application's actual attributes.
"""

import os
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


def test_user_can_log_in_with_valid_credentials(browser, base_url, test_user):
    """Valid credentials should redirect to the dashboard."""
    browser.get(f"{base_url}/login")

    # TODO: Replace with your app's actual selectors
    browser.find_element(By.CSS_SELECTOR, '[data-testid="email"]').send_keys(test_user["email"])
    browser.find_element(By.CSS_SELECTOR, '[data-testid="password"]').send_keys(
        os.environ.get("TEST_USER_PASSWORD", "Test@1234!")
    )
    browser.find_element(By.CSS_SELECTOR, 'button[type="submit"]').click()

    WebDriverWait(browser, 10).until(EC.url_contains("/dashboard"))
    assert "/dashboard" in browser.current_url


def test_shows_error_with_invalid_credentials(browser, base_url):
    """Wrong password should display an error message."""
    browser.get(f"{base_url}/login")

    browser.find_element(By.CSS_SELECTOR, '[data-testid="email"]').send_keys(
        "notauser@example-test.com"
    )
    browser.find_element(By.CSS_SELECTOR, '[data-testid="password"]').send_keys("wrongpassword")
    browser.find_element(By.CSS_SELECTOR, 'button[type="submit"]').click()

    error = WebDriverWait(browser, 5).until(
        EC.visibility_of_element_located((By.CSS_SELECTOR, '[data-testid="login-error"]'))
    )
    assert error.is_displayed()


def test_redirects_unauthenticated_users_to_login(browser, base_url):
    """Accessing a protected route without a session should redirect to /login."""
    browser.get(f"{base_url}/dashboard")

    WebDriverWait(browser, 10).until(EC.url_contains("/login"))
    assert "/login" in browser.current_url
