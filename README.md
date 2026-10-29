# ClipForge

Automated short-form video editor: upload clips and music, describe the video, get a finished edit.

## Run it on your own Windows PC (free)

What you need: Windows 10 or 11, 8 GB RAM or more (16 GB is better), and about 40 GB of free disk.

1. On the PC, click Start, type **PowerShell**, right-click it and choose **Run as administrator**.
2. Paste this and press Enter:

   ```
   irm https://raw.githubusercontent.com/Smaxhy/video-editing/main/deploy/install-windows.ps1 | iex
   ```

   - The first time, it installs WSL and asks you to **restart**. Restart, then run the same command again.
   - Docker Desktop opens the first time. Accept its terms (skip the sign-in) and leave it open.
   - The build takes 10–25 minutes.
   - **Claude login**: a link opens. Log in, paste the code back, then copy the token it prints
     (starts with `sk-ant-oat01-`) and paste it when asked.
   - **Tailscale login**: log in, and click Enable if it asks about HTTPS.
3. **Phone**: install the Tailscale app and log in with the same account. Scan the QR code that opens on
   the PC, then Share → Add to Home Screen. The app password is printed at the end.

After that:
- It starts by itself when you sign in to Windows.
- The PC stays awake while plugged in. You can turn the screen off.
- It updates itself without breaking a render.
- There's a **ClipForge** shortcut on the desktop.

The PC has to be on for your phone to reach it.

In a new terminal, `clipforge` shows whether it's running. `clipforge help` lists the rest: open, url,
password, logs, update and restart.

## Run it on your own server (no Codespaces)

1. **Make the server** (Vultr → Deploy → Cloud Compute): Ubuntu 24.04 x64, 4 vCPU / 8 GB RAM or more.
2. **Connect** from your phone with Termius: the server's IP, user `root`, and the password Vultr shows.
3. **Install**: paste this and press Enter (the first run takes 10–25 minutes):

   ```
   curl -fsSL https://raw.githubusercontent.com/Smaxhy/video-editing/main/deploy/install-server.sh -o i.sh && bash i.sh
   ```

   It asks for two logins. Open each link on your phone:
   - **Claude**: log in, copy the code and paste it back into Termius.
   - **Tailscale**: log in, and click Enable if it asks about HTTPS.
4. **Phone**: install the Tailscale app and log in with the same account. Open the link the installer
   printed, then Share → Add to Home Screen. The app password is printed at the end.

After that it runs on its own. It restarts after reboots and updates itself without breaking a render.

### The `clipforge` command (on the server)

| Command | What it does |
| --- | --- |
| `clipforge` | Is it running, version, link, what it's doing, disk and memory |
| `clipforge url` | The phone link and a QR code |
| `clipforge password` | Show the app password |
| `clipforge logs` | Live log (Ctrl+C to leave) |
| `clipforge update` | Install the newest version now (also un-sticks a frozen render) |
| `clipforge restart` | Restart |
| `clipforge login` | Log in to Claude again |
| `clipforge space` | What is using the disk |
