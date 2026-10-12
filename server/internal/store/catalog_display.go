package store

import (
	_ "embed"
	"encoding/json"
)

// A vendored copy of the public display catalog keeps offline NAS clients usable.
// It can change presentation only; execution still uses verified local recipes.
//
//go:embed catalog_display.json
var displayJSON []byte

func applyDisplay(recipe RuntimeRecipe) RuntimeRecipe {
	var items map[string]struct {
		Description   string `json:"description"`
		Documentation string `json:"documentation"`
 IconURL string `json:"iconUrl"`
	}
	if json.Unmarshal(displayJSON, &items) == nil {
		if item, ok := items[recipe.AppID]; ok {
			recipe.Description = item.Description
			recipe.Documentation = item.Documentation
 recipe.CatalogIconURL=item.IconURL
		}
	}
	return recipe
}
