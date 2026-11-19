// The one place to change project-specific values on the site.
// Everything that names the repository, the example server, or a shell command
// reads from here, so forks only edit this file.

const repo = "Crosery/herdr-pocket";
const server = "pocket.example.com";

export const SITE = {
  name: "Herdr Pocket",
  repo,
  server,
  githubUrl: `https://github.com/${repo}`,
  releasesUrl: `https://github.com/${repo}/releases`,
  docsUrl: `https://github.com/${repo}#readme`,
  issuesUrl: `https://github.com/${repo}/issues`,
  licenseUrl: `https://github.com/${repo}/blob/main/LICENSE`,
  /** Relative to the page, so the site works under any base path. */
  video: {
    src: "video/intro.mp4",
    /** 720p copy, about a third of the size; the default on phones and slow connections. */
    srcSd: "video/intro-720.mp4",
    poster: "video/intro-poster.webp",
  },
  commands: {
    serverCompose: `mkdir herdr-pocket && cd herdr-pocket\ncurl -fsSLO https://raw.githubusercontent.com/${repo}/main/deploy/docker/compose.yml\ndocker compose up -d\ndocker compose logs relay | grep "setup code"`,
    serverScript: `curl -fsSL https://raw.githubusercontent.com/${repo}/main/scripts/install-relay.sh | sudo bash -s -- --domain ${server}`,
    serverCloudflare: `curl -fsSL https://raw.githubusercontent.com/${repo}/main/scripts/install-relay.sh | sudo bash -s -- --tunnel <TUNNEL_TOKEN> --domain ${server}`,
    computerInstall: `curl -fsSL https://raw.githubusercontent.com/${repo}/main/scripts/install-host.sh | bash -s -- --server https://${server}`,
    computerInstallWindows: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/${repo}/main/scripts/install-host.ps1))) -Server https://${server}`,
    computerUp: `herdr-pocket up --server ${server}`,
    computerPair: "herdr-pocket pair",
    cliAgents: "herdr-pocket agents",
    cliRead: "herdr-pocket read  macbook/t42",
    cliSend: "herdr-pocket send  macbook/t42 run the tests",
    cliKeys: "herdr-pocket keys  macbook/t42 esc",
  },
} as const;

export type Lang = "zh" | "en";
