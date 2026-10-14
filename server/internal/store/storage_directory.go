package store

import (
	"context"
	"encoding/json"
	"errors"
)

type storageDirectoryCreator interface {
	CreateStorageDirectory(context.Context, string, string) (StorageCandidate, error)
}

func (e *commandEngine) CreateStorageDirectory(ctx context.Context, path, parentIdentity string) (StorageCandidate, error) {
	out, err := e.storageCommand(ctx, "create", path, parentIdentity)
	var candidate StorageCandidate
	if err != nil {
		return candidate, errors.New("创建失败：父目录身份、权限或新目录状态未通过检查；已有数据均保留。")
	}
	if json.Unmarshal([]byte(out), &candidate) != nil || candidate.Path != path || !safeDataStorage(candidate) {
		return candidate, errors.New("新目录尚无法确认，未登记；请检查目录和数据盘状态。")
	}
	return candidate, nil
}
