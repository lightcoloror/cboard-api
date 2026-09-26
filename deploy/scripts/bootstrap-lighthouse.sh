#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=DEBIAN_FRONTEND bash "$0" "$@"
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot determine the operating system." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]] || [[ "${VERSION_ID:-}" != "22.04" ]]; then
  echo "This bootstrap is limited to Ubuntu 22.04 hosts." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/8] Installing host prerequisites"
apt-get update
apt-get install -y ca-certificates curl git jq ufw unattended-upgrades

echo "[2/8] Applying available Ubuntu updates"
apt-get \
  -o Acquire::Retries=5 \
  -o Dpkg::Options::=--force-confold \
  dist-upgrade -y

echo "[3/8] Installing Docker Engine from Docker's signed apt repository"
install -m 0755 -d /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl --fail --silent --show-error --location \
    --connect-timeout 15 \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 3 \
    https://download.docker.com/linux/ubuntu/gpg \
    --output /etc/apt/keyrings/docker.asc
fi
chmod a+r /etc/apt/keyrings/docker.asc

architecture="$(dpkg --print-architecture)"
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get -o Acquire::Retries=5 update
apt-get -o Acquire::Retries=5 install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin
systemctl enable --now docker.service containerd.service

echo "[4/8] Limiting Docker container log growth"
install -m 0755 -d /etc/docker
daemon_candidate="$(mktemp)"
if [[ -s /etc/docker/daemon.json ]]; then
  jq \
    '. + {"registry-mirrors":(((."registry-mirrors" // []) + ["https://mirror.ccs.tencentyun.com"]) | unique),"log-driver":"local","log-opts":((."log-opts" // {}) + {"max-size":"10m","max-file":"3"})}' \
    /etc/docker/daemon.json > "${daemon_candidate}"
else
  printf '%s\n' \
    '{' \
    '  "registry-mirrors": [' \
    '    "https://mirror.ccs.tencentyun.com"' \
    '  ],' \
    '  "log-driver": "local",' \
    '  "log-opts": {' \
    '    "max-size": "10m",' \
    '    "max-file": "3"' \
    '  }' \
    '}' > "${daemon_candidate}"
fi
dockerd --validate --config-file "${daemon_candidate}"
install -m 0644 "${daemon_candidate}" /etc/docker/daemon.json
rm -f "${daemon_candidate}"
systemctl restart docker.service

echo "[5/8] Ensuring a 2 GiB swap file"
swap_total_kib="$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)"
if (( swap_total_kib < 2000000 )); then
  if [[ -e /swapfile ]]; then
    echo "/swapfile already exists but total swap is below 2 GiB; refusing to overwrite it." >&2
    exit 1
  fi
  if ! fallocate -l 2G /swapfile; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
  fi
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -Fqx '/swapfile none swap sw 0 0' /etc/fstab; then
    printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi
printf '%s\n' 'vm.swappiness = 10' > /etc/sysctl.d/99-tuyujia.conf
sysctl --system >/dev/null

echo "[6/8] Enabling automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades.service

echo "[7/8] Enforcing key-only SSH access"
install -m 0755 -d /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/00-tuyujia-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
EOF
sshd -t
systemctl reload ssh.service

echo "[8/8] Enabling a host firewall with SSH as the only inbound service"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

install -d -m 0750 -o ubuntu -g ubuntu /srv/tuyujia

echo "Bootstrap completed. Verification summary:"
docker --version
docker compose version
systemctl is-active docker.service containerd.service unattended-upgrades.service
swapon --show
ufw status verbose
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|maxauthtries) '
