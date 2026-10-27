import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { bridgeName, firewallRules, rulesBlock } from "../src/sandboxes/firewall.ts";

setDefaultTimeout(60_000); // see test/setup.ts

const net = { bridge: bridgeName("0123456789abcdef"), subnet: "172.20.0.0/16", gateway: "172.20.0.1" };

describe("agent network firewall", () => {
  test("bridge name uses the first 12 id chars", () => expect(net.bridge).toBe("br-0123456789ab"));

  test("rules cover RFC1918 and the gateway; own subnet is exempt", () => {
    const r = firewallRules(net).join("\n");
    for (const d of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]) expect(r).toContain(`-d ${d} -j REJECT`);
    expect(r).toContain("-I INPUT -i br-0123456789ab");
    expect(firewallRules(net).at(-1)).toContain("-j RETURN");
  });

  test("rulesBlock accepts the printed rules and rejects partial ones", () => {
    const rules = firewallRules(net);
    const asS = (xs: string[]) => xs.map((x) => x.replace("iptables -I", "-A")).join("\n");
    const du = asS(rules.filter((r) => r.includes("DOCKER-USER")));
    const inp = asS(rules.filter((r) => r.includes(" INPUT ")));
    expect(rulesBlock(net, du, inp)).toBe(true);
    expect(rulesBlock(net, "", inp)).toBe(false);
    expect(rulesBlock(net, du, "")).toBe(false);
    expect(rulesBlock(net, du.split("\n").filter((l) => !l.includes("192.168")).join("\n"), inp)).toBe(false);
  });
});

describe("rule order", () => {
  test("applying the commands with -I leaves the own-subnet RETURN above every REJECT", () => {
    const stack: string[] = [];
    for (const r of firewallRules(net).filter((r) => r.includes("DOCKER-USER"))) stack.unshift(r);
    expect(stack[0]).toContain("-j RETURN");
    expect(stack.slice(1).every((r) => r.includes("-j REJECT"))).toBe(true);
  });

  test("a port-restricted INPUT reject is not a gateway block", () => {
    const du = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map((d) => `-A DOCKER-USER -d ${d} -i ${net.bridge} -j REJECT`).join("\n");
    expect(rulesBlock(net, du, `-A INPUT -i ${net.bridge} -p tcp -m tcp --dport 22 -j REJECT`)).toBe(false);
  });
});
