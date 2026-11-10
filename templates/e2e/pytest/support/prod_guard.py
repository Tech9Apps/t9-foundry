"""Layer 5 production guard.

The decision procedure is a port of hooks/lib/url-guard.js (the reference): tests/fixtures/guard-cases.json is run against every
implementation (shell hooks, TypeScript, Python, Ruby), so a change here must be made there too or that table fails.

  1. a configured prodUrlPatterns regex matching ANY normalized form of the URL -> block (both modes)
  2. blockOnSuspiciousUrls is False -> allow (enforce mode never overrides this opt-out)
  3. a host that cannot be verified (variables, escapes, odd characters, not http(s)) -> block in enforce, warn otherwise
  4. a known tracker/registry host, an allowedUrlPatterns match, or the configured test environment's own host -> allow
  5. a host that is recognizably NOT production (a staging/test/dev/qa/... LABEL, a reserved or private address) -> allow
  6. anything else is an unrecognized host: block in enforce (fail closed), warn otherwise
"""
import os
import re
from typing import Any, Dict, List, NamedTuple, Optional

_NONPROD_TOKENS = {"staging", "stage", "stg", "test", "testing", "dev", "develop", "development", "qa", "uat", "sandbox", "sbx", "preprod", "preview", "integration"}
_PROD_TOKENS = {"prod", "production", "live", "prd"}
_RESERVED_TLDS = {"test", "example", "invalid", "localhost", "local"}
_DOC_HOSTS = ["example.com", "example.org", "example.net"]
_BUILTIN_EXEMPT_HOSTS = [
    "github.com", "githubusercontent.com", "gitlab.com", "bitbucket.org", "dev.azure.com", "visualstudio.com", "api.clickup.com",
    "atlassian.net", "atlassian.com", "registry.npmjs.org", "npmjs.org", "npmjs.com", "registry.yarnpkg.com", "pypi.org",
    "pythonhosted.org", "rubygems.org", "nodejs.org",
]


class _Parsed(NamedTuple):
    scheme: str
    host: str
    port: str
    v6: bool
    path: str
    verifiable: bool


def _on_label_boundary(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def _parse_url(url: str) -> Optional[_Parsed]:
    m = re.match(r"^(https?)://([^/?#]*)([^?#]*)", str(url), re.IGNORECASE)
    if not m:
        return None
    scheme = m.group(1).lower()
    authority = m.group(2)
    if "\\" in authority:  # browsers and curl disagree about "\": do not guess
        return None
    at = authority.rfind("@")
    hostport = authority[at + 1:] if at >= 0 else authority
    port = ""
    v6 = False
    if hostport.startswith("["):
        b = re.fullmatch(r"\[([^\]]*)\](?::(\d*))?", hostport)
        if not b:
            return None
        host = b.group(1).lower()
        port = b.group(2) or ""
        v6 = True
    else:
        b = re.fullmatch(r"([^:]*)(?::(\d*))?", hostport)
        if not b:
            return None
        host = re.sub(r"\.+$", "", b.group(1).lower())  # "host." and "host" are the same host
        port = b.group(2) or ""
    if not host:
        return None
    path = "/" if m.group(3) == "" else m.group(3)  # query and fragment are not part of what a pattern may match
    verifiable = bool(re.fullmatch(r"[0-9a-f:.]+", host)) if v6 else bool(re.fullmatch(r"[a-z0-9._-]+", host))
    return _Parsed(scheme, host, port, v6, path, verifiable)


def _to_ipv4(host: str) -> Optional[str]:
    """inet_aton semantics: 1-4 parts, each decimal / 0x-hex / 0-octal, the last part fills the remaining bytes."""
    if not re.fullmatch(r"[0-9a-fx.]+", host, re.IGNORECASE):
        return None
    parts = host.split(".")
    if len(parts) > 4 or any(p == "" for p in parts):
        return None
    nums: List[int] = []
    for p in parts:
        if re.fullmatch(r"0x[0-9a-f]+", p, re.IGNORECASE):
            nums.append(int(p, 16))
        elif re.fullmatch(r"0[0-7]+", p):
            nums.append(int(p, 8))
        elif re.fullmatch(r"[0-9]+", p):
            nums.append(int(p, 10))
        else:
            return None
    last = nums[-1]
    room = 2 ** (8 * (5 - len(nums)))
    if any(n > 255 for n in nums[:-1]) or last >= room:
        return None
    value = last
    for i, n in enumerate(nums[:-1]):
        value += n * 2 ** (8 * (3 - i))
    return ".".join(str(x) for x in [value // 2 ** 24 % 256, value // 2 ** 16 % 256, value // 256 % 256, value % 256])


def _is_private_v4(ip: str) -> bool:
    a, b = (int(x) for x in ip.split(".")[:2])
    return a == 127 or a == 10 or a == 0 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) or (a == 169 and b == 254)


def _is_private_v6(host: str) -> bool:
    if host == "::1":
        return True
    if re.match(r"^f[cd][0-9a-f]{2}:", host) or re.match(r"^fe[89ab][0-9a-f]:", host):
        return True
    mapped = re.fullmatch(r"::ffff:(\d+\.\d+\.\d+\.\d+)", host)
    ip = _to_ipv4(mapped.group(1)) if mapped else None
    return bool(ip) and _is_private_v4(ip)


def _nonprod_host(u: _Parsed) -> bool:
    if u.v6:
        return _is_private_v6(u.host)
    ip = _to_ipv4(u.host)
    if ip:
        return _is_private_v4(ip)
    if u.host == "localhost" or u.host.endswith(".localhost"):
        return True
    labels = u.host.split(".")
    if len(labels) > 1 and labels[-1] in _RESERVED_TLDS:
        return True
    if any(_on_label_boundary(u.host, d) for d in _DOC_HOSTS):
        return True
    # Tokens come from the host's labels WITHOUT its TLD (".dev" is a real TLD, not a staging marker), split on . - _ and compared
    # whole: "devices", "aqua" and "attestation" are not "dev", "qa" and "test".
    tokens = [t for t in re.split(r"[._-]", ".".join(labels[:-1])) if t]
    if any(t in _PROD_TOKENS for t in tokens):  # "test-prod.acme.com" is production wearing a hat
        return False
    return any(t in _NONPROD_TOKENS for t in tokens)


def _candidates(url: str, u: _Parsed) -> List[str]:
    out = [str(url)]
    hosts = [u.host]
    ip = None if u.v6 else _to_ipv4(u.host)
    if ip and ip != u.host:
        hosts.append(ip)
    for h in hosts:
        hs = "[" + h + "]" if u.v6 else h
        out += [u.scheme + "://" + hs + u.path, hs]
        if u.port:
            out += [u.scheme + "://" + hs + ":" + u.port + u.path, hs + ":" + u.port]
    return list(dict.fromkeys(out))


def _compile(pattern: str, flags: int = 0):
    try:
        return re.compile(pattern, flags)
    except re.error:
        return None


def _starts_at_host(rx, form: str, end: int) -> bool:
    """Does `rx` first match INSIDE "scheme://host[:port]", the first `end` characters of `form`? (A match that begins at the first character of the path is not inside it.)"""
    m = rx.search(form)
    return m is not None and m.start() < end


def decide_url(url: str, cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Optional[str]]:
    """decide_url(url, {mode, prodUrlPatterns, allowedUrlPatterns, blockOnSuspiciousUrls, testEnvironmentBaseUrl})
    -> {decision: 'allow' | 'warn' | 'block', reason, detail}"""
    cfg = cfg or {}
    enforce = cfg.get("mode") == "enforce"

    def failing(reason: str, detail: Optional[str] = None) -> Dict[str, Optional[str]]:
        return {"decision": "block" if enforce else "warn", "reason": reason, "detail": detail}

    u = _parse_url(url)

    forms = _candidates(url, u) if u and u.verifiable else [str(url)]
    for pattern in cfg.get("prodUrlPatterns") or []:
        rx = _compile(pattern, re.IGNORECASE) if pattern else None  # case-insensitive: hosts are
        if rx and any(rx.search(f) for f in forms):
            return {"decision": "block", "reason": "PROD_PATTERN", "detail": pattern}

    if cfg.get("blockOnSuspiciousUrls") is False:
        return {"decision": "allow", "reason": "HEURISTIC_DISABLED", "detail": None}

    if not u:
        return failing("UNPARSEABLE", "not an http(s) URL with a plain host")
    if not u.verifiable:
        return failing("UNVERIFIABLE_HOST", "the host contains a variable, escape, or non-plain character")

    if any(_on_label_boundary(u.host, d) for d in _BUILTIN_EXEMPT_HOSTS):
        return {"decision": "allow", "reason": "EXEMPT_HOST", "detail": None}
    shown = "[" + u.host + "]" if u.v6 else u.host
    authority = u.scheme + "://" + shown + (":" + u.port if u.port else "")
    stripped = authority + u.path  # no userinfo, query or fragment
    plain_authority = u.scheme + "://" + u.host
    # An allow pattern has to START matching within "scheme://host[:port]". It may go on into the path ("://partner\\.io/guide" allows what is under
    # /guide), but text that merely appears later, inside the path of some other host ("https://evil.com/go/https://partner.io/guide"), allows nothing.
    for pattern in cfg.get("allowedUrlPatterns") or []:
        rx = _compile(pattern) if pattern else None  # an invalid allow-pattern never exempts anything
        if rx and (_starts_at_host(rx, stripped, len(authority)) or _starts_at_host(rx, plain_authority + u.path, len(plain_authority))):
            return {"decision": "allow", "reason": "ALLOWED_PATTERN", "detail": pattern}
    test_env = _parse_url(cfg["testEnvironmentBaseUrl"]) if cfg.get("testEnvironmentBaseUrl") else None
    if test_env and test_env.verifiable and test_env.host == u.host:
        return {"decision": "allow", "reason": "TEST_ENV_HOST", "detail": None}

    if _nonprod_host(u):
        return {"decision": "allow", "reason": "NONPROD_HOST", "detail": None}
    return failing("UNRECOGNIZED_HOST")


def _config_error() -> Optional[str]:
    """Why qa-config.json could not be read, or None. A loader that cannot read the config must not be mistaken for 'no config'."""
    try:
        from .qa_config_loader import load_qa_config

        load_qa_config()
        return None
    except ImportError:
        return None
    except Exception as exc:  # noqa: BLE001 - any failure to read the config is reported, not swallowed
        return f"{type(exc).__name__}: {exc}"


def _load_config() -> dict:
    try:
        from .qa_config_loader import load_qa_config

        return load_qa_config() or {}
    except Exception:  # noqa: BLE001 - reported by _config_error() before this is used
        return {}


def validate_not_production(base_url: str, patterns: Optional[List[str]] = None) -> None:
    """Layer 5 production guard — raises RuntimeError if base_url matches any production URL pattern, or (in enforce mode) is not
    recognizably a test environment. Called in conftest.py before any test runs.

    Args:
        base_url: The test environment URL to validate.
        patterns: List of regex patterns identifying production URLs.
                  If None, patterns are loaded from qa-config.json automatically.

    Guard mode: with QA_AUTONOMOUS=1 (unattended runs) or productionProtection.mode == "enforce", a URL that is not recognizably
    non-production raises instead of only warning — a warning nobody reads is not a guard. If qa-config.json exists but cannot be
    read, an unattended run is blocked (it would otherwise silently run without its production patterns).
    """
    if not base_url:
        raise RuntimeError("BASE_URL is not set. Add it to .env.test or export it in your shell.")

    error = _config_error()
    if error:
        if os.environ.get("QA_AUTONOMOUS") == "1":
            raise RuntimeError(
                "BLOCKED: qa-config.json could not be read, so the production patterns it holds cannot be applied "
                f"({error}).\nFix the file; unattended runs (QA_AUTONOMOUS=1) do not continue without it."
            )
        print(f"WARNING: qa-config.json could not be read ({error}); production patterns are NOT being applied.")

    config = _load_config()
    protection = config.get("productionProtection", {}) or {}
    if patterns is None:
        patterns = protection.get("prodUrlPatterns", []) or []
    enforce = os.environ.get("QA_AUTONOMOUS") == "1" or protection.get("mode") == "enforce"

    for pattern in patterns:
        if pattern and _compile(pattern) is None:
            print(f"WARNING: Skipping invalid production URL pattern: {pattern}")

    d = decide_url(base_url, {
        "mode": "enforce" if enforce else "warn",
        "prodUrlPatterns": patterns,
        "allowedUrlPatterns": protection.get("allowedUrlPatterns", []) or [],
        "blockOnSuspiciousUrls": False if protection.get("blockOnSuspiciousUrls", True) is False else None,
        "testEnvironmentBaseUrl": (config.get("environments", {}) or {}).get("testEnvironmentBaseUrl"),
    })
    if d["decision"] == "allow":
        return

    if d["reason"] == "PROD_PATTERN":
        raise RuntimeError(
            f"BLOCKED: BASE_URL '{base_url}' matches a production pattern: {d['detail']}\n"
            "Tests must never run against production. "
            "Update BASE_URL in .env.test to point at your staging environment."
        )
    if d["decision"] == "block":
        raise RuntimeError(
            f"BLOCKED: BASE_URL '{base_url}' is not recognizably a test environment ({d['reason']}) and guard mode is "
            "'enforce' (QA_AUTONOMOUS=1 or productionProtection.mode).\n"
            "Set BASE_URL to your staging URL, or add a regex for this URL to "
            "productionProtection.allowedUrlPatterns in qa-config.json if it is safe."
        )
    print(
        f"WARNING: BASE_URL '{base_url}' may be a production URL ({d['reason']}). "
        "Configure productionProtection.prodUrlPatterns in qa-config.json to enable strict blocking."
    )
