export class Router {
  constructor() {
    this.routes = new Map();
  }
  
  get(path, handler) {
    this.routes.set(`GET:${path}`, handler);
  }
  
  post(path, handler) {
    this.routes.set(`POST:${path}`, handler);
  }
  
  matchPath(routePath, actualPath) {
    const routeParts = routePath.split('/');
    const actualParts = actualPath.split('/');
    
    if (routeParts.length !== actualParts.length) return null;
    
    const params = {};
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = actualParts[i];
      } else if (routeParts[i] !== actualParts[i]) {
        return null;
      }
    }
    
    return params;
  }
  
  async handle(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    
    // Try exact match first
    const exactKey = `${method}:${path}`;
    if (this.routes.has(exactKey)) {
      return await this.routes.get(exactKey)(request, env);
    }
    
    // Try pattern match
    for (const [key, handler] of this.routes) {
      const [routeMethod, routePath] = key.split(':');
      if (routeMethod !== method) continue;
      
      const params = this.matchPath(routePath, path);
      if (params) {
        request.params = params;
        return await handler(request, env);
      }
    }
    
    return new Response('Not Found', { status: 404 });
  }
}
