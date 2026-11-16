import type { CtlMessage } from "./protocol";
import type { DuplexLink } from "./shutter";
import { sendChunks, type SendChannel } from "./transfer";

/** Adapts an RTCDataChannel (or a fake with the same surface) to the shutter's DuplexLink. */
export function channelLink(channel: SendChannel & { send(data: string): void }): DuplexLink {
  return {
    isOpen: () => channel.readyState === "open",
    sendCtl(message: CtlMessage) {
      if (channel.readyState !== "open") throw new Error("channel not open");
      channel.send(JSON.stringify(message));
    },
    sendBinary: (tx, data) => sendChunks(channel, tx, data),
  };
}
