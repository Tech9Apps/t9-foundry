import os
import time
from typing import Any, Callable, Dict, List, Optional

try:
    import requests as _requests
except ImportError:
    _requests = None  # type: ignore


class DataFactory:
    """Registry-based test data factory.

    Every entity created via this factory is registered for cleanup.
    Call DataFactory.cleanup_all() in the session-scoped teardown
    fixture in conftest.py — it runs automatically after the full test run.

    Customize the entity methods to match your application's API.
    The registry and cleanup_all() method should not need changes.
    """

    _registry: List[Dict[str, Any]] = []

    # ── Entity factories ─────────────────────────────────────────────────────

    @classmethod
    def create_user(cls, **attrs: Any) -> Dict[str, Any]:
        """Create a test user via the application API and register for cleanup."""
        if _requests is None:
            raise ImportError("pip install requests to use DataFactory")

        base_url = os.environ["BASE_URL"]
        defaults: Dict[str, Any] = {
            "email": f"test-{int(time.time() * 1000)}@example-test.com",
            "role": "user",
        }
        payload = {**defaults, **attrs}

        # TODO: Replace with your application's user creation API endpoint
        response = _requests.post(f"{base_url}/api/users", json=payload)
        response.raise_for_status()
        user: Dict[str, Any] = response.json()

        def _cleanup() -> None:
            _requests.delete(f"{base_url}/api/users/{user['id']}")  # type: ignore[union-attr]

        cls._registry.append({"type": "user", "id": user["id"], "cleanup": _cleanup})
        return user

    # Add more factory methods here following the same pattern:
    #
    # @classmethod
    # def create_order(cls, **attrs) -> Dict[str, Any]:
    #     base_url = os.environ["BASE_URL"]
    #     resp = requests.post(f"{base_url}/api/orders", json={...})
    #     resp.raise_for_status()
    #     order = resp.json()
    #     cls._registry.append({"type": "order", "id": order["id"],
    #                           "cleanup": lambda: requests.delete(...)})
    #     return order

    # ── Cleanup ───────────────────────────────────────────────────────────────

    @classmethod
    def cleanup_all(cls) -> None:
        """Delete all registered entities in reverse creation order."""
        for entity in reversed(cls._registry):
            cleanup_fn: Optional[Callable[[], None]] = entity.get("cleanup")
            if cleanup_fn:
                try:
                    cleanup_fn()
                except Exception as exc:
                    print(f"DataFactory cleanup warning ({entity['type']} {entity['id']}): {exc}")
        cls._registry.clear()

    @classmethod
    def registry(cls) -> List[Dict[str, Any]]:
        return list(cls._registry)
