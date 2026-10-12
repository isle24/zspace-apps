import { expect, it } from "vitest";
import { localPhotoConnection } from "./photo-quality";

it.each(["http://192.168.3.56:5055", "https://10.0.2.7", "http://172.16.1.4", "http://127.0.0.1", "https://nas.local", "http://[::1]", "http://[fd00::5]"])("defaults to original photos on a local NAS connection %s", value => {
  expect(localPhotoConnection(value)).toBe(true);
});
it.each([undefined, "", "not a URL", "https://nas.example.com", "https://172.32.1.4", "https://192.168.example.com"])("keeps previews for a remote or unknown connection %s", value => {
  expect(localPhotoConnection(value)).toBe(false);
});
