{
    description = "dim-live-viewer: a live 3D scene of a running dimOS stack, as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            apps = forAllSystems (pkgs: {
                install = {
                    type = "app";
                    # nothing to build (a plain-JS page); parse its module script so a broken edit fails the install
                    program = toString (pkgs.writeShellScript "install" ''
                        set -e
                        page=dim/apps/live_viewer/frontend/index.html
                        test -f dim/apps/live_viewer/frontend/icon.svg
                        ${pkgs.gawk}/bin/awk '/<script type="module">/{on=1; next} /<\/script>/{on=0} on' "$page" \
                            | ${pkgs.esbuild}/bin/esbuild --loader=js --format=esm --log-level=error > /dev/null
                        echo "dim-live-viewer: $page parses"
                    '');
                };
            });
        };
}
