/**
 * A tiny in-memory stand-in for WebRTC, just enough for the booth's RemoteCamera and the phone's
 * PhoneCamera to negotiate and talk. The "SDP" names the offering peer; setting the answer links
 * the two ends, opens the data channel and delivers the phone's track to the booth. Messages on
 * the channel arrive asynchronously, in order, like a reliable ordered SCTP channel.
 */
export class FakeNet {
  peers = new Map<string, FakePeer>();
  nextId = 1;
  /** Called with every string/binary payload before delivery; return null to drop it. */
  filter: ((from: FakePeer, data: string | ArrayBuffer) => string | ArrayBuffer | null) | null =
    null;
  messages: Array<{ from: string; kind: "text" | "binary"; text?: string; size?: number }> = [];
}

export class FakeTrack {
  kind = "video";
  readyState: "live" | "ended" = "live";
  muted = false;
  private listeners = new Map<string, Set<() => void>>();
  constructor(
    public settings: { width: number; height: number; facingMode?: string } = {
      width: 4032,
      height: 3024,
      facingMode: "environment",
    },
  ) {}
  addEventListener(type: string, fn: () => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  end() {
    this.readyState = "ended";
    this.emit("ended");
  }
  stop() {
    this.readyState = "ended";
  }
  getSettings() {
    return this.settings;
  }
  async applyConstraints(c: { width?: { ideal: number }; height?: { ideal: number } }) {
    this.constraintCalls.push(c);
  }
  constraintCalls: unknown[] = [];
}

export class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
}

export class FakeDataChannel {
  readyState: "connecting" | "open" | "closed" = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  peer: FakeDataChannel | null = null;
  private listeners = new Map<string, Set<() => void>>();
  constructor(
    readonly owner: FakePeer,
    readonly label: string,
  ) {}
  addEventListener(type: string, fn: () => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== "open") throw new Error("InvalidStateError");
    let payload: string | ArrayBuffer;
    if (typeof data === "string") payload = data;
    else if (data instanceof ArrayBuffer) payload = data.slice(0);
    else
      payload = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
    const net = this.owner.net;
    net.messages.push(
      typeof payload === "string"
        ? { from: this.owner.id, kind: "text", text: payload }
        : { from: this.owner.id, kind: "binary", size: payload.byteLength },
    );
    const out = net.filter ? net.filter(this.owner, payload) : payload;
    if (out === null) return;
    const target = this.peer;
    queueMicrotask(() => {
      if (target?.readyState === "open") target.onmessage?.({ data: out });
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
    for (const fn of [...(this.listeners.get("close") ?? [])]) fn();
    const other = this.peer;
    if (other && other.readyState !== "closed") queueMicrotask(() => other.close());
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
}

export class FakePeer {
  readonly id: string;
  connectionState = "new";
  ontrack: ((e: { track: FakeTrack; streams: FakeStream[] }) => void) | null = null;
  onicecandidate:
    | ((e: {
        candidate: null | { candidate: string; sdpMid: string; sdpMLineIndex: number };
      }) => void)
    | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: FakeDataChannel }) => void) | null = null;
  dc: FakeDataChannel | null = null;
  transceivers: FakeTransceiver[] = [];
  remote: FakePeer | null = null;
  iceAdded: unknown[] = [];
  closed = false;
  sdpRequests = 0;

  constructor(
    readonly net: FakeNet,
    readonly config: unknown,
  ) {
    this.id = `peer${net.nextId++}`;
    net.peers.set(this.id, this);
  }
  createDataChannel(label: string) {
    this.dc = new FakeDataChannel(this, label);
    return this.dc;
  }
  addTransceiver(kind: string, init: { direction: string }) {
    const t = new FakeTransceiver(kind, init.direction);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    return { type: "offer" as const, sdp: `fake-offer:${this.id}` };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: `fake-answer:${this.id}` };
  }
  async setLocalDescription() {
    this.sdpRequests++;
  }
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    const other = this.net.peers.get(desc.sdp.split(":")[1]!);
    if (!other) throw new Error("bad sdp");
    this.remote = other;
    if (desc.type === "offer") {
      // The answering side learns the offerer's transceiver and channel.
      this.transceivers = [new FakeTransceiver("video", "recvonly")];
      const dc = new FakeDataChannel(this, other.dc?.label ?? "ftl");
      this.dc = dc;
      dc.peer = other.dc;
      if (other.dc) other.dc.peer = dc;
      queueMicrotask(() => this.ondatachannel?.({ channel: dc }));
    } else {
      // Answer received: the link is up.
      const track = other.transceivers[0]?.sender.track;
      queueMicrotask(() => {
        this.connectionState = "connected";
        other.connectionState = "connected";
        if (track) this.ontrack?.({ track, streams: [new FakeStream([track])] });
        this.dc?.open();
        other.dc?.open();
      });
    }
  }
  async addIceCandidate(c: unknown) {
    this.iceAdded.push(c);
  }
  async getStats() {
    const map = new Map<string, Record<string, unknown>>();
    this.statsFrames += 5;
    map.set("in", { type: "inbound-rtp", kind: "video", framesDecoded: this.statsFrames });
    map.set("out", {
      type: "outbound-rtp",
      kind: "video",
      frameWidth: this.outboundWidth,
      frameHeight: 720,
    });
    return map;
  }
  statsFrames = 0;
  outboundWidth = 1280;
  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = "closed";
    this.dc?.close();
  }
  /** Simulate the network dropping: both sides see the link fail. */
  fail() {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}

export class FakeTransceiver {
  direction: string;
  receiver = { track: { kind: "video" } };
  sender: {
    track: FakeTrack | null;
    replaceTrack(t: FakeTrack): Promise<void>;
    getParameters(): { encodings?: Array<Record<string, unknown>> };
    setParameters(p: unknown): Promise<void>;
    params: unknown;
  } = {
    track: null,
    params: null,
    replaceTrack: async (t) => {
      this.sender.track = t;
    },
    getParameters: () => ({ encodings: [{}] }),
    setParameters: async (p) => {
      this.sender.params = p;
    },
  };
  constructor(
    readonly kind: string,
    direction: string,
  ) {
    this.direction = direction;
  }
}
