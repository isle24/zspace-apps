import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AppArtwork } from "./AppArtwork";
afterEach(cleanup);
it.each(["jellyfin", "immich", "syncthing"])(
  "uses controlled official local artwork for %s",
  (appId) => {
    const { container } = render(
      <AppArtwork appId={appId} icon="https://untrusted.invalid/icon.svg" />,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      `/app-icons/${appId}.svg`,
    );
  },
);

it("has a real graphic for the custom reader",()=>{const view=render(<AppArtwork appId="nasreader"/>);expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/app-icons/nasreader.svg")});
