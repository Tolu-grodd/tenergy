#!/data/data/com.termux/files/usr/bin/sh
# One-time setup of the Tenergy agent in Termux. Run from inside the unzipped agent folder:  sh setup-termux.sh
set -e
echo "== Updating Termux (a few minutes the first time). A full upgrade is needed, or Node can fail to start."
pkg update -y
pkg upgrade -y
echo "== Installing packages"
pkg install -y nodejs-lts termux-api curl
node --version || { echo "Node still will not start. Run: termux-change-repo   (pick another mirror) then run this script again."; exit 1; }
echo "== Installing the agent's libraries"
npm install --no-audit --no-fund
echo "== Setting up start-on-boot"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/tenergy.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd "$HOME/agent" && node --env-file=.env agent.js >> agent.log 2>&1
EOF
chmod +x "$HOME/.termux/boot/tenergy.sh"
echo
echo "Done. Next, in this folder:"
echo "  node agent.js --test-camera     (then:  termux-open last-photo.jpg)"
echo "  node local-test.js              (reads the plugs over Wi-Fi, read-only)"
