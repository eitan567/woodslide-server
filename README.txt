WOOD SLIDE MATCH SERVER (no dependencies, needs Node 18+)

A) Home network (free):
  1. On a PC connected to the same Wi-Fi as both phones, install Node.js (nodejs.org).
  2. In this folder run:  node server.js
  3. Find the PC's local IP (Windows: ipconfig, look for IPv4, e.g. 192.168.1.20).
  4. In the game: Multiplayer, Server address = 192.168.1.20:8080, then one player creates a room and gives the 4-digit code to the other.
  Allow Node through the Windows firewall for private networks if asked.

B) Render.com free web service:
  1. Put this folder in a Git repository (GitHub/GitLab) that your Render account can read.
  2. Render dashboard: New > Web Service > pick the repo, Runtime Node, Start Command "node server.js", Instance Type Free
     (or New > Blueprint using render.yaml).
  3. When deployed, the address looks like your-name.onrender.com. Enter that in the game as the server address (no port).
  Free-instance notes (render.com/docs/free): the service spins down after 15 minutes without traffic and takes about a minute to wake on the next connection; 750 free instance hours per month per workspace.
  Match rules: creator picks 5/10/15/20 challenges; same board for both players; first to solve earns 1 point; time limit per challenge by difficulty (60/90/120 s); no solve in time = no point; most points wins, equal = draw.
