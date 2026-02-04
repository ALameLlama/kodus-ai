{
  description = "Development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Create a docker wrapper script that calls podman
        dockerWrapper = pkgs.writeShellScriptBin "docker" ''
          exec ${pkgs.podman}/bin/podman "$@"
        '';

        # Create a docker-compose wrapper script that calls podman-compose
        dockerComposeWrapper = pkgs.writeShellScriptBin "docker-compose" ''
          exec ${pkgs.podman-compose}/bin/podman-compose "$@"
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Node.js LTS with npm included
            nodejs_22

            # Yarn package manager
            yarn

            # Podman for container management
            podman

            # Podman Compose
            podman-compose

            # OpenSSL
            openssl

            # Useful utilities for podman rootless setup
            crun
            conmon
            slirp4netns
            fuse-overlayfs

            # Docker compatibility wrappers
            dockerWrapper
            dockerComposeWrapper
          ];

          shellHook = ''
             echo "Development environment loaded!"
             echo "Node.js version: $(node --version)"
             echo "NPM version: $(npm --version)"
             echo "Yarn version: $(yarn --version)"
             echo "Podman version: $(podman --version)"
             echo "OpenSSL version: $(openssl version)"
             echo ""
             echo "🐳 Docker CLI compatibility enabled (using Podman)"
             echo "   'docker' -> podman"
             echo "   'docker-compose' -> podman-compose"
             echo "   'docker compose' -> podman compose"
             echo ""

             # Set up podman to work in rootless mode
             export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
             export PODMAN_COMPOSE_WARNING_LOGS=false

            # Podman image trust policy
            export CONTAINERS_POLICY="$HOME/.config/containers/policy.json"

            mkdir -p "$HOME/.config/containers"

            if [ ! -f "$CONTAINERS_POLICY" ]; then
              cat > "$CONTAINERS_POLICY" <<'EOF'
            {
              "default": [
                {
                  "type": "insecureAcceptAnything"
                }
              ]
            }
            EOF
            fi

             # Ensure podman directories exist
             mkdir -p $HOME/.local/share/containers
             mkdir -p $HOME/.config/containers

             # Verify docker command works
             if command -v docker &> /dev/null; then
               echo "✓ 'docker' command available"
             fi

             if command -v docker-compose &> /dev/null; then
               echo "✓ 'docker-compose' command available"
             fi

             if docker compose version &> /dev/null 2>&1 || command -v docker-compose &> /dev/null; then
               echo "✓ Docker Compose compatibility verified"
             fi
             echo ""
          '';
        };
      }
    );
}
