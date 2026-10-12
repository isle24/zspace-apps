package store

import _ "embed"

//go:embed storage_host_metadata.py
var storageHostMetadataScript string

// All host and runtime probes share the same attestation, rather than opting in
// at an individual endpoint or accepting an environment-provided evidence path.
var storageScript = "import os,sys,json,subprocess,re\n" + storageHostMetadataScript + storageBodyScript
