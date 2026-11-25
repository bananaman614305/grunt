// Cloudflare Worker routed only to the hosted message endpoint.
export default {
  async fetch(request: Request & { cf?: { country?: string } }, env: { GRUNT_COUNTRY_INGRESS_SECRET?: string }) {
    const url = new URL(request.url);
    if (url.origin !== 'https://api.grunt.run' || url.pathname !== '/agent/messages') {
      return new Response('Unknown route', { status: 404 });
    }
    const headers = new Headers(request.headers);
    headers.delete('X-Grunt-Edge-Auth');
    headers.delete('X-Grunt-Edge-Country');
    const country = request.cf?.country;
    if (country && /^[A-Z]{2}$/.test(country) && country !== 'XX' && env.GRUNT_COUNTRY_INGRESS_SECRET) {
      headers.set('X-Grunt-Edge-Country', country);
      headers.set('X-Grunt-Edge-Auth', env.GRUNT_COUNTRY_INGRESS_SECRET);
    }
    return fetch(new Request(request, { headers, redirect: 'manual' }));
  }
};
