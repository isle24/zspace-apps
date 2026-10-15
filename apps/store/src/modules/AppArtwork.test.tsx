import { cleanup, fireEvent, render } from "@testing-library/react";
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

it('loads published artwork through the controlled cloud path and falls back to GitHub then a glyph', () => {
  const hash = 'a'.repeat(64);
  const view = render(<AppArtwork appId="published-reader" icon={`/api/cloud/icons/${hash}`} />);
  expect(view.container.querySelector('img')).toHaveAttribute('src', `https://zstore.2iwm.com/api/cloud/icons/${hash}`);
  expect(view.container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('img')).toHaveAttribute('src', `https://raw.githubusercontent.com/isle24/nas-app-store-catalog/main/icons/${hash}.png`);
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('svg')).not.toBeNull();
  view.rerender(<AppArtwork appId="published-reader" icon={`/api/cloud/icons/${'b'.repeat(64)}`} />);
  expect(view.container.querySelector('img')).toHaveAttribute('src', `https://zstore.2iwm.com/api/cloud/icons/${'b'.repeat(64)}`);
});

it('falls back for a missing bundled logo and never requests untrusted artwork', () => {
  const view = render(<AppArtwork appId="navidrome" icon="music" />);
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('img')).toBeNull();
  view.rerender(<AppArtwork appId="unknown" icon="https://untrusted.invalid/icon.svg" />);
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('svg')).not.toBeNull();
});
