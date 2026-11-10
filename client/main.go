// Agent: a desktop client for the local pi-durable agent.
//
// The Go side owns the window and two small conveniences the page cannot do
// itself: reading the bridge token/port from the agent's .env, and running
// scripts/agentctl so the app can show agent status and start/stop it.
// Everything else (transcript, streaming, input) goes straight from the page to
// the agent's HTTP/WS bridge on 127.0.0.1.
package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

// defaultHome is the agent checkout; override with PI_DURABLE_HOME.
const defaultHome = "/Users/example/learn/pi-durable-agent"

// Agent exposes the local bridge settings to the page.
type Agent struct{}

func agentHome() string {
	if home := os.Getenv("PI_DURABLE_HOME"); home != "" {
		return home
	}
	return defaultHome
}

// envValue reads one key from the agent's .env without loading the whole file.
func envValue(key string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	data, err := os.ReadFile(filepath.Join(agentHome(), ".env"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, found := strings.Cut(line, "=")
		if !found || strings.TrimSpace(name) != key {
			continue
		}
		return strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return ""
}

// BaseURL is the agent bridge the page should talk to.
func (Agent) BaseURL() string {
	port := envValue("AGENT_HTTP_PORT")
	if port == "" {
		port = "8787"
	}
	host := envValue("AGENT_HTTP_HOST")
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + host + ":" + port
}

// Token is the bridge token; empty means the bridge has auth disabled.
func (Agent) Token() string { return envValue("AGENT_HTTP_TOKEN") }

// Home is the agent checkout, shown in the app and used by Control.
func (Agent) Home() string { return agentHome() }

// Status runs scripts/agentctl status and returns its output.
func (Agent) Status() string { return runAgentctl("status") }

// Control runs one agentctl action: start, stop, restart, backup.
func (Agent) Control(action string) string {
	switch action {
	case "start", "stop", "restart", "backup":
		return runAgentctl(action)
	default:
		return "unsupported action: " + action
	}
}

// Notify shows a native notification (used when a turn finishes while the window is
// in the background). Returns "denied" when the system refuses notifications.
func (Agent) Notify(title string, body string) string {
	note := mygo.NewNotification(mygo.NotificationOptions{Title: title, Body: body, Group: "agent"})
	if err := note.Show(); err != nil {
		return err.Error()
	}
	return ""
}

// OpenLogs reveals the agent log directory in Finder.
func (Agent) OpenLogs() string {
	logs := filepath.Join(agentHome(), "logs")
	out, err := exec.Command("open", logs).CombinedOutput()
	if err != nil {
		return "open failed: " + err.Error() + " " + strings.TrimSpace(string(out))
	}
	return logs
}

func runAgentctl(action string) string {
	script := filepath.Join(agentHome(), "scripts", "agentctl")
	cmd := exec.Command(script, action)
	cmd.Dir = agentHome()
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		return text + "\n" + err.Error()
	}
	return text
}

func main() {
	mygo.Bind(Agent{})

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:           "Agent",
			Width:           1180,
			Height:          820,
			MinWidth:        720,
			MinHeight:       480,
			BackgroundColor: "light-dark(#f6f7f9, #0f1115)",
			StateKey:        "main",
			URL:             "/",
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
