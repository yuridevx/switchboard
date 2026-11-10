package main

// Служба macOS: агент launchd пользователя этого флота (~/Library/LaunchAgents). KeepAlive — launchd поднимает Keeper после выхода;
// AbandonProcessGroup — при остановке агента держатели и их процессы живут. Установка поверх своего агента — перезапуск с новым файлом.
import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func agentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", serviceName()+".plist"), nil
}

func launchctl(args ...string) error {
	out, err := exec.Command("launchctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func domain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

func registered() error { return nil }

func register(dst string, _ bool, _ *bufio.Reader) error {
	path, err := agentPath()
	if err != nil {
		return err
	}
	var args strings.Builder
	for _, a := range append([]string{dst}, runArgs()...) {
		args.WriteString("    <string>" + xmlText(a) + "</string>\n")
	}
	plist := "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" +
		"<plist version=\"1.0\"><dict>\n  <key>Label</key><string>" + serviceName() + "</string>\n  <key>ProgramArguments</key><array>\n" + args.String() +
		"  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>AbandonProcessGroup</key><true/>\n</dict></plist>\n"
	if err := writeFile(path, []byte(plist)); err != nil {
		return err
	}
	// прежний агент этого флота снимается: ошибки «не загружен» — не сбой
	exec.Command("launchctl", "bootout", domain()+"/"+serviceName()).Run()
	return launchctl("bootstrap", domain(), path)
}

func unregister() error {
	path, err := agentPath()
	if err != nil {
		return err
	}
	if err := launchctl("bootout", domain()+"/"+serviceName()); err != nil {
		return err
	}
	return os.Remove(path)
}

func xmlText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func asService() bool { return false }
func runService() int { return 1 }
func hideConsole()    {}
