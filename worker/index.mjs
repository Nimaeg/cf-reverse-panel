import { connect } from 'cloudflare:sockets';
import { TunnelController } from './controller.mjs';
import { handleRequest, scheduled } from './router.mjs';
import { NativeController } from '../native/controller.mjs';
export class NativeReverseDO extends NativeController {
  constructor(state, env) { super(state, env, { connect }); }
}
export class TunnelDO extends TunnelController {
  constructor(state, env) {
    super(state, env, { connect, fetchWebSocket: async (url, options) => {
      const response = await fetch(url, options);
      if (response.status !== 101 || !response.webSocket) {
        await response.body?.cancel(); throw new Error(`Iran upgrade rejected (${response.status})`);
      }
      return response.webSocket;
    } });
  }
}
export default { fetch: handleRequest, scheduled };
