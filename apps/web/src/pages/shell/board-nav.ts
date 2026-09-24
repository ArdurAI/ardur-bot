import { msg } from "@lingui/core/macro";
import { registerTopNavItem } from "./top-nav";

// The route is available before its screen chunk is loaded.
registerTopNavItem({ id: "board", label: msg`Board`, to: "/app/team", order: 30, available: true });
