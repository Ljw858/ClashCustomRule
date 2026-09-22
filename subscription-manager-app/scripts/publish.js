const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise(resolve => rl.question(query, resolve));

async function main() {
    console.log("=========================================");
    console.log("    一键触发云端打包并发布到 GitHub      ");
    console.log("=========================================\n");

    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = require(pkgPath);
    console.log(`当前版本: ${pkg.version}`);
    
    const newVersion = await question(`请输入新版本号 (直接回车表示不修改，保持当前版本): `);
    let v = pkg.version;
    if (newVersion && newVersion.trim() !== "") {
        v = newVersion.trim().replace(/^v/, '');
        pkg.version = v;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        
        const htmlPath = path.join(__dirname, '..', 'src', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');
        // 替换界面底部的版本号
        html = html.replace(/>v\d+\.\d+\.\d+</g, `>v${v}<`);
        html = html.replace(/v\d+\.\d+\.\d+<\/div>/g, `v${v}</div>`);
        fs.writeFileSync(htmlPath, html);
        console.log(`\n[成功] 配置文件版本号已自动更新为 v${v}`);
    }

    let token = process.env.GH_TOKEN;
    const tokenFile = path.join(__dirname, '..', '.publish-token');
    
    if (!token && fs.existsSync(tokenFile)) {
        token = fs.readFileSync(tokenFile, 'utf-8').trim();
    }

    if (!token) {
        console.log("\n【注意】首次发布需要你的 GitHub Token (必须勾选 repo 权限)。");
        token = await question(`请输入 GitHub Token (只需输入一次，后续会自动保存): `);
        token = token.trim();
        if (!token) {
            console.log("\n[错误] 未提供 Token，取消发布。");
            process.exit(1);
        }
        fs.writeFileSync(tokenFile, token);
        console.log("[成功] Token 已保存到本地 (.publish-token)");
    }

    console.log("\n>>> 开始提交代码并触发云端自动打包发布...\n");
    try {
        const repoRoot = path.join(__dirname, '..', '..');
        
        // 执行 Git 提交和打标签
        console.log("正在添加修改到 Git...");
        execSync('git add subscription-manager-app', { cwd: repoRoot, stdio: 'inherit' });
        
        console.log("正在提交修改...");
        try {
            execSync(`git commit -m "chore: bump desktop app version to v${v}"`, { cwd: repoRoot, stdio: 'inherit' });
        } catch(e) {
            console.log("(如果没有修改则跳过提交)");
        }
        
        console.log(`正在创建标签 v${v}...`);
        try {
            execSync(`git tag v${v}`, { cwd: repoRoot, stdio: 'inherit' });
        } catch(e) {
            console.log(`(标签 v${v} 可能已存在)`);
        }
        
        // 注入 token 到远程地址以实现无密码推送
        const remoteUrl = `https://${token}@github.com/Ljw858/ClashCustomRule.git`;
        
        console.log("正在推送代码到 GitHub...");
        execSync(`git push "${remoteUrl}" master`, { cwd: repoRoot, stdio: 'inherit' });
        
        console.log(`正在推送标签 v${v} 到 GitHub...`);
        execSync(`git push "${remoteUrl}" v${v}`, { cwd: repoRoot, stdio: 'inherit' });

        console.log("\n=========================================");
        console.log(" 🎉 代码已成功推送到 GitHub！");
        console.log(" GitHub Actions 将在云端自动为你打包并发布。");
        console.log(" 大约 2-3 分钟后，你可以前往 GitHub Releases 页面查看结果：");
        console.log(" https://github.com/Ljw858/ClashCustomRule/releases");
        console.log("=========================================");
    } catch (e) {
        console.error("\n[错误] 发布失败。");
        console.error("1. 请检查你的网络是否通畅。");
        console.error("2. 请检查你的 GitHub Token 是否有效。");
        console.error(e.message);
    }
    rl.close();
}

main();
