const COMMON_PASSWORDS = new Set(`
password123 password1234 password12345 password123456 password1234567 password12345678
password12 password01 password11 password22 password99 password00 password111 password222
password321 password000 password999 password007 password!1 password!! password!23
qwertyuiop qwerty12345 qwerty123456 qwertyuiop1 qwertyuiop12 qwertyuiop123
1234567890 0123456789 0987654321 12345678910 1234512345 123456123456
123456789012 123456789123 12345678900 12345678901 123456789! 123456789a
iloveyou12 iloveyou123 iloveyou1234 iloveyou!! iloveyou01 iloveyou11
abcdefghij abcdefghijkl abcdefghijklmnopqrstuvwxyz abc1234567 abc123456789
admin12345 admin123456 admin1234567 administrator administrator1 adminadmin
letmein123 letmein1234 letmein12345 welcome123 welcome1234 welcome12345
welcome123! welcome2020 welcome2021 welcome2022 welcome2023 welcome2024
welcome2025 welcome2026 welcome2027 welcome2028 welcomehome welcomehome1
changeme123 changeme1234 changeme12345 changeme!! changeit123 changeit1234
dragon1234 dragon12345 dragon123456 monkey1234 monkey12345 monkey123456
football12 football123 football1234 football01 football11 football99
baseball12 baseball123 baseball1234 basketball basketball1 basketball12
superman12 superman123 superman01 superman11 batman1234 batman12345
princess12 princess123 princess01 princess11 sunshine12 sunshine123
sunshine01 sunshine11 sunshine99 sunshine!! michael123 michael1234
michael12345 jennifer12 jennifer123 jennifer01 jennifer11 charlie123
charlie1234 charlie12345 charlie111 charlie2020 charlie2021 charlie2022
charlie2023 charlie2024 charlie2025 charlie2026 charlie2027 charlie2028
charlie2029 charlie2030 charlie!!1 charlie!!! charlie000 charlie999
alexander1 alexander12 alexander123 alexander01 alexander11 alexander99
christopher christopher1 christopher12 christopher123 christopher01
christian1 christian12 christian123 christian01 christian11 christian99
thomas1234 thomas12345 thomas123456 robert1234 robert12345 robert123456
daniel1234 daniel12345 daniel123456 andrew1234 andrew12345 andrew123456
joshua1234 joshua12345 joshua123456 matthew123 matthew1234 matthew12345
internet12 internet123 internet1234 computer12 computer123 computer1234
computer01 computer11 computer99 computer!! trustnoone trustnoone1
trustnoone12 trustnoone123 secret1234 secret12345 secret123456 secretpassword
passw0rd12 passw0rd123 passw0rd1234 p@ssword12 p@ssword123 p@ssw0rd123
p@ssw0rd1234 p@ssword1234 passwordpassword passwordpassword1 password2020
password2021 password2022 password2023 password2024 password2025 password2026
password2027 password2028 password2029 password2030 password2019 password2018
password2017 password2016 password2015 password2014 password2013 password2012
password2011 password2010 password2009 password2008 password2007 password2006
password2005 password2004 password2003 password2002 password2001 password2000
asdfghjkl1 asdfghjkl12 asdfghjkl123 zxcvbnm123 zxcvbnm1234 qazwsxedc1
qazwsxedc12 qazwsxedc123 1qaz2wsx3e 1qaz2wsx3edc 1q2w3e4r5t 1q2w3e4r5t6y
lovely1234 lovely12345 hello12345 helloworld helloworld1 helloworld123
testing123 testing1234 test123456 test1234567 temporary1 temporary123
`.trim().split(/\s+/));

export const PASSWORD_POLICY_MESSAGE = 'password must be 10..128 characters and must not be common, repetitive, consecutive, or contain your email name';

export function checkPassword(password: string, email?: string): boolean {
  if (password.length < 10 || password.length > 128) return false;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || new Set(password).size < 4) return false;
  const codes = Array.from(password, (character) => character.codePointAt(0)!);
  if ([1, -1].some((step) => codes.slice(1).every((code, i) => code - codes[i]! === step))) return false;
  const local = email?.split('@')[0]?.toLowerCase();
  return !(local && local.length >= 4 && lower.includes(local));
}
