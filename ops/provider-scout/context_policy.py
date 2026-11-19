"""Usable input requirements for automatic provider qualification."""
from urllib.parse import urlsplit

DEFAULT_MINIMUM = 200_000
EXCEPTIONS = {('100milionseek.top', 'deepseek-v4.1-flash-free'): 198_000}
CONTEXT_GUIDANCE = (
    'at least 200,000 usable input tokens, with an approved 198,000 minimum '
    'for the exact 100milionseek.top deepseek-v4.1-flash-free route'
)


def meets_context_requirement(candidate):
    tokens = candidate['context_tokens']
    if type(tokens) is not int:
        return False
    host = urlsplit(candidate['homepage']).hostname
    return tokens >= EXCEPTIONS.get((host, candidate['model']), DEFAULT_MINIMUM)
