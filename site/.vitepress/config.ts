import { defineConfig } from "vitepress";

// bunker.true.engineer: built from the repo's docs/*.md (copied into guide/ by scripts/prepare-docs.ts).
export default defineConfig({
  lang: "en",
  title: "bunker",
  description: "Label a GitHub issue, get back a reviewed, tested, merged pull request: Claude coding agents in sandboxed git worktrees.",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: "https://bunker.true.engineer" },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#4f46e5" }],
    ["meta", { property: "og:title", content: "bunker" }],
    ["meta", { property: "og:description", content: "Label a GitHub issue. Get back a reviewed, tested, merged pull request." }],
  ],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Get started", link: "/guide/getting-started" },
      { text: "Concepts", link: "/guide/concepts" },
      { text: "Security", link: "/guide/security" },
      { text: "CLI", link: "/guide/cli" },
      { text: "Changelog", link: "https://github.com/dbggr/bunker/blob/main/CHANGELOG.md" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Concepts", link: "/guide/concepts" },
          { text: "Security", link: "/guide/security" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/guide/cli" },
          { text: "Releasing", link: "/guide/release" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/dbggr/bunker" }],
    search: { provider: "local" },
    editLink: {
      // Pages come from docs/*.md in the repo, so edits go there.
      pattern: ({ filePath }) => `https://github.com/dbggr/bunker/edit/main/docs/${filePath.replace(/^guide\//, "")}`,
      text: "Edit this page on GitHub",
    },
    outline: { level: [2, 3] },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Pre-1.0: flags, config and labels may change before 1.0.",
    },
  },
});
