/** Minimal ICE server shape (what RTCConfiguration.iceServers takes). */
export interface RtcIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
