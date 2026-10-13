import "@testing-library/jest-dom/vitest";
import {vi} from 'vitest';
// Public network discovery is independently tested with explicit HTTP fixtures.
vi.mock('./api/public-catalog',()=>({readPublicCatalog:vi.fn(async()=>({items:[]}))}));
