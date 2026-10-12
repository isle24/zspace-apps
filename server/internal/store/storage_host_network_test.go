package store

import (
	"context"
	"errors"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

const hostNetworkFixture = hostMetadataFixture + `
network='/run/space-store-host/net'
header='  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
def entry(port,ipv6=False,state='0A'):
 addr='0'*32 if ipv6 else '00000000'
 return ' 0: '+addr+':%04X '%port+addr+':0000 '+state+' 00000000:00000000 00:00000000 00000000 1001 0 12345 1 0000000000000000 100 0 0 10 0\n'
tables={name:header for name in ('tcp','tcp6','udp','udp6')}
docker_ports=[]
base_lstat=os.lstat
os.lstat=lambda p:types.SimpleNamespace(st_mode=stat.S_IFREG) if p.startswith(network+'/') else base_lstat(p)
base_fdopen=os.fdopen
fds={};closed=[]
base_close=os.close
base_osopen=os.open
def network_open(p,flags,*args,**kwargs):
 if p in ('/','run','space-store-host','net') and flags&os.O_DIRECTORY:
  assert flags&os.O_NOFOLLOW
  return {'/':90,'run':91,'space-store-host':92,'net':93}[p]
 if p in tables:
  assert flags&os.O_NOFOLLOW and kwargs.get('dir_fd')==93
  fd=100+list(tables).index(p);fds[fd]=p;return fd
 return base_osopen(p,flags,*args,**kwargs)
os.open=network_open
base_fstat=os.fstat
os.fstat=lambda fd:types.SimpleNamespace(st_mode=stat.S_IFREG,st_size=0) if fd in fds else base_fstat(fd)
os.close=lambda fd:closed.append(fd) if fd in fds or fd in (90,91,92,93) else base_close(fd)
os.fdopen=lambda fd,*args,**kwargs:io.StringIO(tables[fds[fd]]) if fd in fds else base_fdopen(fd,*args,**kwargs)
base_container=container_fixture
def network_command(args,**kwargs):
 if args[0]=='docker' and 'ls' in args:return '\n'.join(json.dumps(p) for p in docker_ports)
 return base_container(args,**kwargs)
subprocess.check_output=network_command
base_popen=subprocess.Popen
def network_popen(args,**kwargs):
 if args[0]=='docker':
  assert args[1:3]==['--host','unix:///var/run/docker.sock'] and 'ls' in args
  text='\n'.join(json.dumps(p) for p in docker_ports)
  return base_popen([sys.executable,'-c','import sys;sys.stdout.write('+repr(text)+')'],**kwargs)
 return base_popen(args,**kwargs)
subprocess.Popen=network_popen
socket.socket=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('bridge bind forbidden'))
`

func runHostNetworkFixture(t *testing.T, mutation, protocol string) ([]byte, error) {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable")
	}
	script := "import os,sys,json,subprocess,re\n" + storageHostMetadataScript
	// The attestation and API are the exact scope called by runtime ensure_ports.
	script += "\ntry:\n host_policy=own_storage_policy()\n assert host_policy['network']=='/run/space-store-host/net'\n print(json.dumps(host_port_available(32123,protocol=sys.argv[1],publishHost='192.168.3.56')))\nexcept Exception: sys.exit(3)\n"
	return exec.Command("python3", "-c", hostNetworkFixture+mutation+script, protocol).CombinedOutput()
}

func TestAttestedHostPortAvailableUsesHostTablesForBridgeNASIP(t *testing.T) {
	out, err := runHostNetworkFixture(t, "", "tcp")
	if err != nil || strings.TrimSpace(string(out)) != "true" {
		t.Fatal(err, string(out))
	}
}

func TestAttestedHostPortAvailableRejectsHostListenersAndDockerNAT(t *testing.T) {
	cases := map[string]string{
		"host pid TCP listen":  "tables['tcp']+=entry(32123)\n",
		"host pid TCP6 listen": "tables['tcp6']+=entry(32123,True)\n",
		"UDP bound":            "tables['udp']+=entry(32123,state='07')\n",
		"UDP6 bound":           "tables['udp6']+=entry(32123,True,state='07')\n",
		"docker NAT no proxy":  "docker_ports=['192.168.3.56:32123->3001/tcp']\n",
		"docker IPv6 wildcard": "docker_ports=[':::32123->3001/tcp']\n",
		"docker port range":    "docker_ports=['0.0.0.0:32120-32125->3000-3005/tcp']\n",
	}
	for name, mutation := range cases {
		t.Run(name, func(t *testing.T) {
			protocol := "tcp"
			if strings.HasPrefix(name, "UDP") {
				protocol = "udp"
			}
			out, err := runHostNetworkFixture(t, mutation, protocol)
			if err != nil || strings.TrimSpace(string(out)) != "false" {
				t.Fatal("occupied host port accepted", err, string(out))
			}
		})
	}
}

func TestAttestedHostPortAvailableFailsClosedOnForgedOrUnreadableTables(t *testing.T) {
	cases := map[string]string{
		"RW net bind":        "actual['Mounts'][-1]['RW']=True\n",
		"foreign net source": "actual['Mounts'][-1]['Source']='/proc/self/net'\n",
		"foreign net target": "actual['Mounts'][-1]['Destination']='/tmp/net'\n",
		"missing net bind":   "actual['Mounts'].pop()\n",
		"table symlink":      "os.fstat=lambda fd:types.SimpleNamespace(st_mode=stat.S_IFLNK,st_size=0) if fd in fds else base_fstat(fd)\n",
		"unreadable table":   "os.fdopen=lambda fd,*args,**kwargs:(_ for _ in ()).throw(PermissionError('secret-unreadable-detail')) if fd in fds else base_fdopen(fd,*args,**kwargs)\n",
		"empty table":        "tables['tcp6']=''\n",
		"invalid row":        "tables['udp']+='broken record\\n'\n",
		"invalid port":       "tables['tcp']+=entry(32123).replace('7D7B','XXXXX')\n",
		"oversize table":     "tables['udp6']=header+'x'*1048577\n",
		"malformed docker":   "docker_ports=['not-a-port']\n",
	}
	for name, mutation := range cases {
		t.Run(name, func(t *testing.T) {
			out, err := runHostNetworkFixture(t, mutation, "tcp")
			var failure *exec.ExitError
			if !errors.As(err, &failure) || failure.ExitCode() != 3 || len(out) != 0 {
				t.Fatal("network evidence failed open/exposed output", err, string(out))
			}
		})
	}
}

func TestLegacyLocalPortAvailableUsesAttestedPolicyBeforeBind(t *testing.T) {
	calls := 0
	e := &commandEngine{mode: "local", bindHost: "192.168.3.56", runner: func(ctx context.Context, name string, args ...string) (string, string, error) {
		calls++
		if name != "python3" || len(args) != 4 || args[0] != "-c" || args[2] != strconv.Itoa(32123) || args[3] != "192.168.3.56" {
			t.Fatalf("legacy port bypassed attested helper: %s %#v", name, args)
		}
		out, err := exec.Command("python3", append([]string{"-c", hostNetworkFixture + args[1]}, args[2:]...)...).CombinedOutput()
		return string(out), "", err
	}}
	if err := e.PortAvailable(context.Background(), 32123); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("unexpected legacy calls", calls)
	}
}

func TestAttestedHostPortAvailableAcceptsKernelIPv6Header(t *testing.T) {
	// tcp6 uses remote_address; the IPv4 proc header uses rem_address.
	out, err := runHostNetworkFixture(t, "tables['tcp6']=header.replace('rem_address','remote_address')\n", "tcp")
	if err != nil || strings.TrimSpace(string(out)) != "true" {
		t.Fatal(err, string(out))
	}
}

func TestHostNetworkCommandCaptureIsBoundedAndSilent(t *testing.T) {
	script := "import os,sys,json,subprocess,re\n" + storageHostMetadataScript + "\ntry:\n bounded_metadata_command([sys.executable,'-c',\"print('x'*1048577)\"])\nexcept Exception: sys.exit(3)\n"
	out, err := exec.Command("python3", "-c", script).CombinedOutput()
	var failure *exec.ExitError
	if !errors.As(err, &failure) || failure.ExitCode() != 3 || len(out) != 0 {
		t.Fatal("unbounded output accepted", err, string(out))
	}
}

func TestHostNetworkCommandCaptureAcceptsBoundedRead(t *testing.T) {
	script := "import os,sys,json,subprocess,re\n" + storageHostMetadataScript + "\nprint(bounded_metadata_command([sys.executable,'-c',\"print('bounded-public-output')\"]).strip())\n"
	out, err := exec.Command("python3", "-c", script).CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "bounded-public-output" {
		t.Fatal(err, string(out))
	}
}

func TestLegacyNormalHostPortAvailableKeepsActualBind(t *testing.T) {
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	calls := 0
	e := &commandEngine{mode: "local", bindHost: "127.0.0.1", runner: func(context.Context, string, ...string) (string, string, error) { calls++; return "host\n", "", nil }}
	if err = e.PortAvailable(context.Background(), port); err == nil {
		t.Fatal("occupied normal host port accepted")
	}
	if calls != 1 {
		t.Fatal("bind failure did not stop port check", calls)
	}
}

func TestLegacyLocalPortFailureDoesNotFallBackToContainerBind(t *testing.T) {
	calls := 0
	e := &commandEngine{mode: "local", bindHost: "192.168.3.56", runner: func(context.Context, string, ...string) (string, string, error) {
		calls++
		return "", "inspect-secret-sentinel", errors.New("unverified")
	}}
	if err := e.PortAvailable(context.Background(), 32123); err == nil || strings.Contains(err.Error(), "inspect-secret-sentinel") {
		t.Fatal("attestation failed open or leaked", err)
	}
	if calls != 1 {
		t.Fatal("unattested legacy check continued", calls)
	}
}

func TestAttestedHostPortAvailableRejectsTruncatedHeader(t *testing.T) {
	out, err := runHostNetworkFixture(t, "tables['tcp']='sl local_address rem_address st\\n'\n", "tcp")
	var failure *exec.ExitError
	if !errors.As(err, &failure) || failure.ExitCode() != 3 || len(out) != 0 {
		t.Fatal("truncated host header accepted", err, string(out))
	}
}
