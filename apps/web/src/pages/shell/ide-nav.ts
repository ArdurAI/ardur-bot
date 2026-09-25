import { msg } from "@lingui/core/macro";
import { registerTopNavItem } from "./top-nav";

registerTopNavItem({ id: "ide", label: msg`IDE`, to: "/app/ide", order: 40, available: true });
