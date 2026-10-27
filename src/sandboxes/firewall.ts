/** Host firewall rules that keep the bunker-agent bridge off the LAN and the docker gateway (#530). Installing them needs root, so bunker only prints and verifies them. */

export interface AgentNet {
  /** Linux bridge interface, e.g. br-0123456789ab. */
  bridge: string;
  subnet: string;
  gateway: string;
}

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"];

/** The bridge name docker derives from a network id (`br-` + first 12 hex chars). */
export const bridgeName = (id: string): string => `br-${id.slice(0, 12)}`;

/** iptables commands (run as root) that block RFC1918/link-local/CGNAT destinations and new connections to the gateway. */
export function firewallRules(n: AgentNet): string[] {
  return [
    ...PRIVATE.map((d) => `iptables -I DOCKER-USER -i ${n.bridge} -d ${d} -j REJECT`),
    `iptables -I INPUT -i ${n.bridge} -m conntrack --ctstate NEW -j REJECT`,
    // -I puts each rule on top, so this last one ends above the REJECTs and exempts the bridge's own subnet
    `iptables -I DOCKER-USER -i ${n.bridge} -s ${n.subnet} -d ${n.subnet} -j RETURN`,
  ];
}

/** True when the given `iptables -S` output for DOCKER-USER and INPUT blocks the bridge's private destinations and the gateway. */
export function rulesBlock(n: AgentNet, dockerUser: string, input: string): boolean {
  const block = (out: string, pred: (l: string) => boolean) =>
    out.split("\n").some((l) => l.includes(`-i ${n.bridge}`) && !/ (-p|--dport|--sport) /.test(l) && /-j (REJECT|DROP)\b/.test(l) && pred(l));
  const lan = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].every((d) => block(dockerUser, (l) => l.includes(`-d ${d}`)));
  const gw = block(input, (l) => !/-d /.test(l) || l.includes(`-d ${n.gateway}`));
  return lan && gw;
}
