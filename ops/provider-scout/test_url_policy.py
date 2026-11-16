import unittest

from url_policy import public_url


class PublicUrlTests(unittest.TestCase):
    def test_plain_public_https_and_global_literal_addresses(self):
        for url in ('https://provider.example/docs', 'https://docs.provider.com/v1/models',
                    'https://8.8.8.8/docs', 'https://[2606:4700:4700::1111]/docs'):
            self.assertTrue(public_url(url), url)

    def test_navigation_requires_explicit_doc_mode_and_finite_values(self):
        for query in ('section=models', 'tab=pricing', 'view=rate-limits',
                      'section=docs&tab=privacy&view=terms'):
            url = 'https://docs.provider.com/?' + query
            self.assertFalse(public_url(url))
            self.assertTrue(public_url(url, allow_navigation=True), query)

    def test_tokens_tracking_unknown_and_encoded_query_forms_are_rejected(self):
        for query in ('token=PRIVATE', 'key=PRIVATE', 'signature=PRIVATE', 'auth=PRIVATE',
                      'password=PRIVATE', 'utm_source=campaign', 'section=PRIVATE',
                      'section=models&token=PRIVATE', 'section=models&section=privacy',
                      '%73ection=models', 'section=%6dodels', 'section=models;', 'q=models',
                      'view=', 'tab=models+privacy', 'section=models&&view=privacy'):
            self.assertFalse(public_url('https://provider.example/?'+query, allow_navigation=True),query)

    def test_private_local_reserved_and_obfuscated_literal_hosts(self):
        for host in ('localhost', 'localhost.', 'docs.localhost', 'metadata.google.internal',
                     'service.local', '10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1',
                     '172.16.2.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1',
                     '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]',
                     '2130706433', '0x7f000001', '127.1', '0177.0.0.1'):
            self.assertFalse(public_url('https://'+host+'/docs'),host)

    def test_malformed_authorities_controls_and_encoded_controls(self):
        for url in ('http://provider.example/docs', 'https:///docs', 'https://user@provider.example',
                    'https://:password@provider.example', 'https://provider.example:bogus/',
                    'https://provider.example:65536/', 'https://provider.example:/',
                    'https://[2606:4700:4700::1111]suffix/', 'https://provider.example../',
                    'https://[::1', 'https://provider..example/', 'https://-provider.example/',
                    'https://provider.example/#models', 'https://provider.example/\nprivate',
                    'https://provider.example/%0aprivate', 'https://provider.example/%00',
                    'https://provider.example/%250a', 'https://provider.example/#',
                    'https://provider.example/%5cprivate', 'https://provider.example/%QQ',
                    'https://provider.example\\@127.0.0.1/', 'https://provider.example/\u200bprivate'):
            self.assertFalse(public_url(url,allow_navigation=True),repr(url))


if __name__ == '__main__':
    unittest.main()
