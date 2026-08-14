@echo off
chcp 65001 >nul
cd /d "%~dp0scripts"
echo 기업마당에서 최신 지원사업 공고를 가져오는 중입니다...
echo.
node fetch-and-tag.mjs
echo.
echo ----------------------------------------
echo 완료되었습니다. 이 창을 닫고 GitHub Desktop에서
echo data\policies.json 변경사항을 확인한 뒤 Commit / Push 해주세요.
echo ----------------------------------------
pause
