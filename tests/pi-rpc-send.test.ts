/**
 * PiRpc send semantics (issue #53, spec #51 ticket 2).
 *
 * The router only sees PiRpc.prompt(text) — the streamingBehavior contract
 * lives inside PiRpc, where the raw `prompt` command is sent via the private
 * RpcClient.send (any-cast, because RpcClient.prompt() does not expose the
 * parameter). These tests inject a fake client (white-box: `client` is
 * private) and assert the exact wire command and error propagation, including
 * the removal of the old error-message-sniffing steer fallback.
 */
import { describe, expect, it, vi } from "vitest";
import { PiRpc } from "../src/rpc/pi-rpc";

type SendMock = ReturnType<typeof vi.fn>;

/** A PiRpc with a fake connected client; `send` records the wire commands. */
function withFakeClient(send: SendMock): PiRpc {
  const rpc = new PiRpc();
  (rpc as unknown as { client: unknown }).client = {
    send,
    waitForIdle: vi.fn().mockResolvedValue(undefined),
  };
  return rpc;
}

describe("PiRpc send semantics (issue #53 ticket 2)", () => {
  it("prompt always carries streamingBehavior=steer as a raw prompt command", async () => {
    const send = vi.fn().mockResolvedValue({ success: true });
    await withFakeClient(send).prompt("hello");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "prompt", message: "hello", streamingBehavior: "steer" });
  });

  it("promptQueued carries streamingBehavior=followUp (Alt+Enter semantics)", async () => {
    const send = vi.fn().mockResolvedValue({ success: true });
    await withFakeClient(send).promptQueued("later please");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "prompt", message: "later please", streamingBehavior: "followUp" });
  });

  it("a success=false response surfaces the upstream error message", async () => {
    const send = vi.fn().mockResolvedValue({ success: false, error: "Agent is streaming" });
    await expect(withFakeClient(send).prompt("hi")).rejects.toThrow("Agent is streaming");
  });

  it("a rejected send propagates unchanged — the /streaming regex fallback is gone", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Agent is streaming"));
    await expect(withFakeClient(send).prompt("hi")).rejects.toThrow("Agent is streaming");
    expect(send).toHaveBeenCalledTimes(1); // no second steer() attempt
  });

  it("waitForIdle delegates to the client, forwarding the timeout", async () => {
    const rpc = withFakeClient(vi.fn().mockResolvedValue({ success: true }));
    await rpc.waitForIdle(1234);
    const client = (rpc as unknown as { client: { waitForIdle: SendMock } }).client;
    expect(client.waitForIdle).toHaveBeenCalledWith(1234);
  });
});

/**
 * respondExtensionUI (issue #54): RpcClient has no public method for
 * extension_ui_response and its generic send() overwrites the command id —
 * so the payload must go straight to the child process's stdin as one JSONL
 * line. White-box: `client` is private, the fake records the written lines.
 */
describe("PiRpc respondExtensionUI (issue #54)", () => {
  function withFakeStdin(): { rpc: PiRpc; write: SendMock } {
    const write = vi.fn();
    const rpc = new PiRpc();
    (rpc as unknown as { client: unknown }).client = {
      process: { stdin: { write, destroyed: false, writable: true } },
    };
    return { rpc, write };
  }

  it("writes one strict JSONL extension_ui_response line (confirmed payload)", async () => {
    const { rpc, write } = withFakeStdin();
    await rpc.respondExtensionUI({ id: "ext-1", confirmed: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(`${JSON.stringify({ type: "extension_ui_response", id: "ext-1", confirmed: true })}\n`);
  });

  it("value and cancelled payloads carry their own wire fields", async () => {
    const { rpc, write } = withFakeStdin();
    await rpc.respondExtensionUI({ id: "ext-2", value: "prod" });
    await rpc.respondExtensionUI({ id: "ext-3", cancelled: true });
    expect(write).toHaveBeenNthCalledWith(1, `${JSON.stringify({ type: "extension_ui_response", id: "ext-2", value: "prod" })}\n`);
    expect(write).toHaveBeenNthCalledWith(2, `${JSON.stringify({ type: "extension_ui_response", id: "ext-3", cancelled: true })}\n`);
  });

  it("throws when the pi process is gone (stdin destroyed/not writable)", async () => {
    const rpc = new PiRpc();
    (rpc as unknown as { client: unknown }).client = {
      process: { stdin: { write: vi.fn(), destroyed: true, writable: false } },
    };
    await expect(rpc.respondExtensionUI({ id: "x", cancelled: true })).rejects.toThrow("stdin is not writable");
  });

  it("throws when not connected at all", async () => {
    await expect(new PiRpc().respondExtensionUI({ id: "x", cancelled: true })).rejects.toThrow("pi RPC not connected");
  });
});
