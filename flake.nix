{
  description = "Nix development environment for v86";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system: 
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [ 
            pkgs.nodejs_20 
            pkgs.nodePackages.typescript 
            pkgs.python312
          ];

          shellHook = ''
            node --version
            npm --version
          '';
        };
      }
    );
}
