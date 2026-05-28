import { EventEmitter } from 'events';

export const guardEvents = new EventEmitter();

guardEvents.setMaxListeners(100);

export function emitGuardEvent(event, payload = {}) {
  guardEvents.emit(event, payload);
}

export function onGuardEvent(event, listener) {
  guardEvents.on(event, listener);
  return () => guardEvents.off(event, listener);
}
