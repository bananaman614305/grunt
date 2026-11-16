"""Pure URL policy for public provider evidence; this does not resolve DNS."""
import ipaddress
import re
import unicodedata
from urllib.parse import unquote, urlsplit

NAVIGATION_KEYS = frozenset({'section', 'tab', 'view'})
NAVIGATION_VALUES = frozenset({
    'models', 'model', 'model-catalog', 'supported-models', 'pricing', 'limits',
    'rate-limits', 'rate_limits', 'quotas', 'usage', 'context', 'context-window',
    'privacy', 'terms', 'tos', 'data-policy', 'security', 'acceptable-use',
    'docs', 'documentation', 'reference', 'api', 'api-reference', 'quickstart',
    'getting-started', 'overview', 'faq', 'features', 'free', 'free-tier', 'billing',
})
LOCAL_SUFFIXES = ('.localhost', '.local', '.localdomain', '.internal', '.lan', '.home', '.home.arpa', '.invalid', '.test', '.onion')


def _unsafe_characters(value):
    return any(character.isspace() or unicodedata.category(character).startswith('C')
               or character == '\\' for character in value)


def public_url(value, allow_navigation=False):
    """Allow HTTPS evidence URLs, optionally with finite public docs selectors.

    Unknown queries, authentication/tracking parameters, userinfo, fragments,
    malformed authorities and literal local/private addresses are rejected.
    Hostnames are checked syntactically; their live DNS resolution is not proven.
    """
    if not isinstance(value, str) or not value or len(value) > 2048 or _unsafe_characters(value):
        return False
    if re.search(r'%(?![0-9a-fA-F]{2})', value):
        return False
    decoded = value
    for _ in range(3):
        decoded = unquote(decoded)
        if _unsafe_characters(decoded):
            return False
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if (parsed.scheme != 'https' or not host or parsed.username is not None
                or parsed.password is not None or '#' in value or '@' in parsed.netloc
                or port is not None and not 1 <= port <= 65535):
            return False
        if '%' in host or parsed.netloc.endswith(':'):
            return False
        if ':' in host and not re.fullmatch(r'\[[0-9a-fA-F:.]+\](?::[0-9]{1,5})?', parsed.netloc):
            return False
        if host.endswith('..') or '?' in value and not parsed.query:
            return False
        host = host.rstrip('.').lower()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            encoded = host.encode('idna').decode('ascii')
            if (len(encoded) > 253 or '.' not in encoded or encoded == 'localhost'
                    or encoded.endswith(LOCAL_SUFFIXES)
                    or re.fullmatch(r'(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*', encoded)
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                           for label in encoded.split('.'))
                    or encoded.rsplit('.', 1)[1].isdigit()):
                return False
        else:
            if (not address.is_global or address.is_private or address.is_loopback
                    or address.is_link_local or address.is_reserved or address.is_multicast
                    or address.is_unspecified):
                return False
        if parsed.query:
            if not allow_navigation or len(parsed.query) > 256:
                return False
            selectors = parsed.query.split('&')
            if len(selectors) > len(NAVIGATION_KEYS):
                return False
            seen = set()
            for selector in selectors:
                if selector.count('=') != 1:
                    return False
                key, selected = selector.split('=')
                if key not in NAVIGATION_KEYS or selected not in NAVIGATION_VALUES or key in seen:
                    return False
                seen.add(key)
        return True
    except (ValueError, UnicodeError):
        return False
