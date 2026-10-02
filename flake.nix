{
    description = "dim-live-viewer: live 3D view, driving and recording for a running dimOS stack, as a dimOS Desktop app";

    inputs = {
        nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
        rust-overlay.url = "github:oxalica/rust-overlay";
        rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
    };

    outputs = { self, nixpkgs, rust-overlay }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; overlays = [ (import rust-overlay) ]; }));
        in {
            packages = forAllSystems (pkgs:
                let
                    rust = pkgs.rust-bin.stable.latest.default;
                    rustPlatform = pkgs.makeRustPlatform { cargo = rust; rustc = rust; };

                    # the page: React + Vite (type-checked first), from package-lock.json
                    frontend = pkgs.buildNpmPackage {
                        pname = "dim-live-viewer-frontend";
                        version = "0.1.0";
                        src = ./frontend;
                        npmDepsHash = "sha256-nMfPTXcTe9isOLJdYf7KVJLNOjWpVJ5UMabV+vjydvA=";
                        installPhase = ''
                            cp -r dist $out
                        '';
                    };

                    # the backend: serves the page (its store path baked in) and records topics to mcap
                    server = rustPlatform.buildRustPackage {
                        pname = "dim-live-viewer-server";
                        version = "0.1.0";
                        src = ./server;
                        cargoLock.lockFile = ./server/Cargo.lock;
                        LIVE_VIEWER_FRONTEND_BUILT = "${frontend}";
                        # the tests open zenoh sessions on loopback; `cargo test` runs them in development
                        doCheck = false;
                    };
                in {
                    inherit frontend server;
                    # what Desktop builds: bin/dimos-app-server, which serves everything under /apps/<name>/
                    dimosApp = pkgs.runCommand "dim-live-viewer" { } ''
                        mkdir -p $out/bin
                        ln -s ${server}/bin/dimos-app-server $out/bin/dimos-app-server
                        cp ${self}/icon.svg $out/icon.svg
                    '';
                    default = self.packages.${pkgs.system}.dimosApp;
                });
        };
}
