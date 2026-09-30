import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { connectionComputerImage, hostAcceptsComputerImage } from "./computer-image.js";

const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const published = "ghcr.io/ardurai/ardur-bot/computer";
const tag = version.includes("-") ? "dev" : version;

it("prefers the connection's image, then the deployment image for Standard, then the channel", () => {
  const own = {
    standardImage: "registry.example/computer:1",
    developerImage: "registry.example/computer:1-developer",
  };
  const deployment = { ARDURBOT_COMPUTER_IMAGE: "mirror.example/computer:2" };
  expect(connectionComputerImage("base", own, deployment)).toBe(own.standardImage);
  expect(connectionComputerImage("developer", own, deployment)).toBe(own.developerImage);
  expect(connectionComputerImage("base", {}, deployment)).toBe("mirror.example/computer:2");
  // The deployment image names Standard; Developer keeps the published profile tag.
  expect(connectionComputerImage("developer", {}, deployment)).toBe(
    `${published}:${tag}-developer`,
  );
  expect(connectionComputerImage("base", {}, {})).toBe(`${published}:${tag}`);
  expect(connectionComputerImage("developer", {}, { ARDURBOT_COMPUTER_CHANNEL: "release" })).toBe(
    `${published}:${version}-developer`,
  );
});

it("appends the legacy tag the way Compose does", () => {
  expect(
    connectionComputerImage(
      "base",
      {},
      {
        ARDURBOT_COMPUTER_IMAGE: "registry.example.com/mirror/ardurbot/computer",
        ARDURBOT_COMPUTER_IMAGE_TAG: "edge",
      },
    ),
  ).toBe("registry.example.com/mirror/ardurbot/computer:edge");
  expect(() => connectionComputerImage("base", {}, { ARDURBOT_COMPUTER_CHANNEL: "edge" })).toThrow(
    "ARDURBOT_COMPUTER_CHANNEL",
  );
});

it("lets the owner's host start only the connection's own or published images", () => {
  const own = { standardImage: "registry.example/computer:1" };
  expect(hostAcceptsComputerImage("registry.example/computer:1", own)).toBe(true);
  expect(hostAcceptsComputerImage(`${published}:1.2.3-developer`, own)).toBe(true);
  expect(hostAcceptsComputerImage(`${published}@sha256:${"c".repeat(64)}`, own)).toBe(true);
  expect(hostAcceptsComputerImage("mirror.example/computer:2", own)).toBe(false);
  expect(hostAcceptsComputerImage(`${published}-copy:dev`, own)).toBe(false);
});
