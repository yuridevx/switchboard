package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

// logonTaskXML — вид установки «при входе пользователя» для машин с оконными приложениями: служба живёт в сессии 0 без рабочего стола. Задача запускает keeper в сессии
// пользователя и повторяет запуск раз в минуту без второго экземпляра: вышедший keeper (сбой или подмена себя) поднимается на следующей минуте (замер 1 нояб.).
// Повтор висит на двух триггерах: «при регистрации» — с установки, «при входе» — после перезагрузки. Только у входа повтор не шёл до первого входа (живой прогон 1 нояб., win).
const logonTaskXML = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Switchboard keeper: исполняет план машины в сессии пользователя.</Description></RegistrationInfo>
  <Triggers>
    <RegistrationTrigger>
      <Enabled>true</Enabled>
      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </RegistrationTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>%[1]s</UserId>
      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>%[1]s</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>%[2]s</Command><Arguments>%[3]s --hide</Arguments></Exec>
  </Actions>
</Task>
`

// logonTask — текст задачи в UTF-16 с меткой порядка байт: другого файла schtasks не принимает.
func logonTask(user, exe string) []byte {
	esc := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace
	b := []byte{0xFF, 0xFE}
	for _, c := range utf16.Encode([]rune(fmt.Sprintf(logonTaskXML, esc(user), esc(exe), esc(strings.Join(runArgs(), " "))))) {
		b = append(b, byte(c), byte(c>>8))
	}
	return b
}

func registerLogon(exe string) error {
	user, _, err := account()
	if err != nil {
		return err
	}
	tmp := filepath.Join(os.TempDir(), serviceName()+"-task.xml")
	if err := os.WriteFile(tmp, logonTask(user, exe), 0o600); err != nil {
		return err
	}
	defer os.Remove(tmp)
	for _, args := range [][]string{{"/Create", "/TN", serviceName(), "/XML", tmp, "/F"}, {"/Run", "/TN", serviceName()}} {
		if out, err := exec.Command("schtasks", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("schtasks %s: %v: %s", args[0], err, out)
		}
	}
	return nil
}

// hideConsole — окно консоли keeper под задачей не нужно.
func hideConsole() {
	if h, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow").Call(); h != 0 {
		windows.NewLazySystemDLL("user32.dll").NewProc("ShowWindow").Call(h, 0) // SW_HIDE
	}
}
