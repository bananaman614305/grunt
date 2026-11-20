"""Trusted operator exclusions, separate from revisitable model observations."""
from urllib.parse import urlsplit

# These are explicit owner decisions, not conclusions inferred by a scout.
# A changed model or advertised entitlement cannot revoke an owner's opt-out.
DEFAULT_EXCLUSIONS = {
    'freeinference.org': 'Owner cancelled FreeInference submission.',
    'axforge.ai': 'Owner excluded AxForge because its allowance is too small.',
    'ccode.si': 'Owner excluded CCode after its free-user access failure.',
    'meldport.com': 'Owner excluded Meldport because its allowance is too small.',
    'packet.ai': 'Owner excluded Packet.ai because signup requires SMS.',
}


def provider_host(homepage):
    return urlsplit(homepage).hostname.lower().removeprefix('www.')


def initialize_exclusions(ledger):
    exclusions = ledger.setdefault('owner_exclusions', {})
    if not isinstance(exclusions, dict):
        raise ValueError('Invalid operator exclusions')
    for host, reason in DEFAULT_EXCLUSIONS.items():
        exclusions.setdefault(host, {'excluded': True, 'reason': reason})
    for host, decision in exclusions.items():
        if (not isinstance(host, str) or host != provider_host('https://' + host)
                or not isinstance(decision, dict) or type(decision.get('excluded')) is not bool
                or not isinstance(decision.get('reason'), str)):
            raise ValueError('Invalid operator exclusion decision')
    return exclusions


def owner_exclusion(candidate, ledger=None):
    decisions = {host: {'excluded': True, 'reason': reason} for host, reason in DEFAULT_EXCLUSIONS.items()}
    decisions.update((ledger or {}).get('owner_exclusions', {}))
    host = provider_host(candidate['homepage'])
    # Parent-domain opt-outs include the provider's signup/docs subdomains.
    applicable = [domain for domain in decisions if host == domain or host.endswith('.' + domain)]
    if not applicable:
        return None
    decision = decisions[max(applicable, key=len)]
    return decision['reason'] if decision.get('excluded') is True else None
