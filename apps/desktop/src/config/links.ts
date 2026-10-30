// Releases and in-app changelogs come from this fork; its updater only trusts this repo's builds.
const GITHUB_REPO = "jacobcaraballo/multistream";

export const APP_LINKS = {
  website: "https://usemultistream.vercel.app",
  github: {
    slug: GITHUB_REPO,
    repo: `https://github.com/${GITHUB_REPO}`,
    releases: `https://github.com/${GITHUB_REPO}/releases`,
    extensionZip: `https://github.com/${GITHUB_REPO}/releases/latest/download/multistream-extension.zip`,
    // forks have issues disabled by default; shared bugs belong upstream
    issues: "https://github.com/ilanzgx/multistream/issues",
  },
  deepLinkScheme: "multistream:",
};
