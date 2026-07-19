/**
 * link-redirect.js
 * Worker for notion.techfusionreport.com
 *
 * Redirects short slugs to full Notion (or any) share URLs via KV lookup.
 * Example: notion.techfusionreport.com/tasker-fix -> https://notion.so/...
 *
 * Requires a KV namespace binding named LINKS (see wrangler.toml below).
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const slug = url.pathname.replace(/^\/+/, "").toLowerCase(); // strip leading slash(es)

    // Root path: friendly landing instead of a 404
    if (!slug) {
      return new Response(
        "notion.techfusionreport.com — add a slug, e.g. /tasker-fix",
        { status: 200, headers: { "content-type": "text/plain" } }
      );
    }

    const dest = await env.LINKS.get(slug);

    if (!dest) {
      return new Response("No link found for that slug.", { status: 404 });
    }

    // 302 = easy to change destination later without breaking the short link.
    // Switch to 301 only once a mapping is permanent and you want caching.
    return Response.redirect(dest, 302);
  },
};
