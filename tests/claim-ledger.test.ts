/**
 * ClaimLedger 域入口测试(spec #299 票02/04 → #352 收口):并发重读、上限
 * 收敛、拒绝身份语义、索引越界 —— 全走公共 API(store 注入真件,落盘形状
 * 即 config.collab 的向后兼容契约)。
 */
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { ClaimLedger } from "../src/collab/claim-ledger.js";

/** 真件 store(空初始配置 + no-op persist:测试永不触碰真实用户配置,
 *  与本套件惯例一致 —— 见 ConfigStore.persist 缝注释)。 */
function makeStore(): ConfigStore {
  return new ConfigStore({}, () => {});
}

describe("ClaimLedger · 读侧(#352)", () => {
  it("空簿记:claims/hasPendingClaim/isRejectedFor/hasNoticed 全空态安全", () => {
    const ledger = new ClaimLedger(makeStore());
    expect(ledger.claims()).toEqual([]);
    expect(ledger.hasPendingClaim("!room:x")).toBe(false);
    expect(ledger.isRejectedFor("!room:x", "https://git.example/a.git")).toBe(false);
    expect(ledger.hasNoticed("!room:x")).toBe(false);
  });

  it("recordClaimCard:挂单与已提示房同步落簿,hasPendingClaim/hasNoticed 命中", () => {
    const ledger = new ClaimLedger(makeStore());
    ledger.recordClaimCard("!room:x", "https://git.example/a.git", "alpha");
    expect(ledger.hasPendingClaim("!room:x")).toBe(true);
    expect(ledger.hasNoticed("!room:x")).toBe(true);
    expect(ledger.claims()).toMatchObject([{ roomId: "!room:x", url: "https://git.example/a.git", projectName: "alpha" }]);
    expect(ledger.claims()[0]!.at).toBeGreaterThan(0);
  });

  it("recordNotice:只记已提示房,不产生挂单", () => {
    const ledger = new ClaimLedger(makeStore());
    ledger.recordNotice("!room:y");
    expect(ledger.hasNoticed("!room:y")).toBe(true);
    expect(ledger.claims()).toEqual([]);
  });

  it("isRejectedFor:键格式「房间|URL」;URL 变更后不再命中(允许重新发卡)", () => {
    const ledger = new ClaimLedger(makeStore());
    ledger.recordClaimCard("!room:x", "https://git.example/a.git", "alpha");
    ledger.rejectClaimAt(1);
    expect(ledger.isRejectedFor("!room:x", "https://git.example/a.git")).toBe(true);
    expect(ledger.isRejectedFor("!room:x", "https://git.example/b.git")).toBe(false);
  });
});

describe("ClaimLedger · 写侧纪律(#352 内化)", () => {
  it("落盘前重读:两次发卡之间的并发 update 不被第二次写覆盖/丢失", () => {
    const store = makeStore();
    const ledger = new ClaimLedger(store);
    ledger.recordClaimCard("!room:a", "https://git.example/a.git", "a");
    // 模拟 router 发卡(await 窗)期间另一路径的并发写:故意整体替换
    // unknownNotifiedRooms(并发方的自主决定),但展开保留 pendingClaims。
    store.update({ collab: { ...store.get().collab, unknownNotifiedRooms: ["!room:other"] } });
    ledger.recordClaimCard("!room:b", "https://git.example/b.git", "b");
    // 重读纪律:第二次写以当下 store 为基 —— 并发写的内容保留(不被覆盖),
    // 自身追加照常落簿;两条挂单(并发 update 展开携带 + ledger 重读续写)不丢。
    expect(store.get().collab?.unknownNotifiedRooms).toEqual(["!room:other", "!room:b"]);
    expect(ledger.claims()).toHaveLength(2);
  });

  it("上限收敛:pendingClaims 封顶 50(丢最旧),键/房簿记封顶 200", () => {
    const store = makeStore();
    const ledger = new ClaimLedger(store);
    for (let i = 0; i < 55; i++) {
      ledger.recordClaimCard(`!room:${i}`, `https://git.example/${i}.git`, `p${i}`);
    }
    expect(ledger.claims()).toHaveLength(50);
    expect(ledger.claims()[0]!.roomId).toBe("!room:5"); // 最旧 5 条被丢
    const ledger2 = new ClaimLedger(store);
    for (let i = 0; i < 205; i++) ledger2.recordNotice(`!n:${i}`);
    expect(store.get().collab?.unknownNotifiedRooms).toHaveLength(200);
    expect(store.get().collab?.unknownNotifiedRooms![0]).toBe("!n:5");
  });

  it("rejectClaimAt:按对象身份过滤 —— 读写窗内并发新增的邀请保留", () => {
    const store = makeStore();
    const ledger = new ClaimLedger(store);
    ledger.recordClaimCard("!room:a", "https://git.example/a.git", "a");
    const snapshot = ledger.claims(); // 交互开始时的快照
    ledger.recordClaimCard("!room:b", "https://git.example/b.git", "b"); // 并发新增
    // 用户拒绝快照里的第 1 条:并发进来的 b 保留,a 移除 + 拒绝键落簿
    const gone = ledger.rejectClaimAt(1);
    expect(gone).toMatchObject({ roomId: "!room:a" });
    expect(ledger.claims()).toHaveLength(1);
    expect(ledger.claims()[0]!.roomId).toBe("!room:b");
    expect(snapshot).toHaveLength(1); // 快照本身不被原地改写
  });

  it("rejectClaimAt 越界返回 undefined,不产生任何写", () => {
    const store = makeStore();
    const ledger = new ClaimLedger(store);
    expect(ledger.rejectClaimAt(0)).toBeUndefined();
    expect(ledger.rejectClaimAt(1)).toBeUndefined();
    expect(store.get().collab).toBeUndefined();
  });

  it("removeClaimForRoom:按房间移除,他房挂单保留", () => {
    const ledger = new ClaimLedger(makeStore());
    ledger.recordClaimCard("!room:a", "https://git.example/a.git", "a");
    ledger.recordClaimCard("!room:b", "https://git.example/b.git", "b");
    ledger.removeClaimForRoom("!room:a");
    expect(ledger.claims()).toHaveLength(1);
    expect(ledger.claims()[0]!.roomId).toBe("!room:b");
  });
});
