//go:build windows

package main

// Вид установки «при входе пользователя» — для машин с оконными приложениями: служба живёт в сессии 0 без рабочего
// стола. Задача планировщика запускает keeper в сессии пользователя и повторяет запуск раз в минуту без второго
// экземпляра: вышедший keeper (сбой или подмена себя) поднимается на следующей минуте (замер 1 нояб.).
// Повтор висит на двух триггерах: «при регистрации» — с установки, «при входе» — после перезагрузки. Только у входа
// повтор не шёл до первого входа: keeper после подмены себя не поднимался (живой прогон 1 нояб., win).
import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows"
)

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

func installLogonTask() error {
	exe, err := placeSelf()
	if err != nil {
		return err
	}
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	acc, dom, _, err := tu.User.Sid.LookupAccount("")
	if err != nil {
		return err
	}
	xml := fmt.Sprintf(logonTaskXML, xmlEscape(dom+`\`+acc), xmlEscape(exe), xmlEscape(strings.Join(runArgs(), " ")))
	// schtasks ждёт файл XML в UTF-16 с меткой порядка байт
	u := utf16.Encode([]rune(xml))
	b := []byte{0xFF, 0xFE}
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	tmp := filepath.Join(os.TempDir(), serviceName+"-task.xml")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	defer os.Remove(tmp)
	if out, err := exec.Command("schtasks", "/Create", "/TN", serviceName, "/XML", tmp, "/F").CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks /Create: %v: %s", err, out)
	}
	if out, err := exec.Command("schtasks", "/Run", "/TN", serviceName).CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks /Run: %v: %s", err, out)
	}
	return nil
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// hideConsole — окно консоли keeper под задачей не нужно.
func hideConsole() {
	k := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetConsoleWindow")
	u := windows.NewLazySystemDLL("user32.dll").NewProc("ShowWindow")
	if h, _, _ := k.Call(); h != 0 {
		u.Call(h, 0) // SW_HIDE
	}
}
