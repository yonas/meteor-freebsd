# Meteor

Meteor is an ultra-simple environment for building modern web
applications.

With Meteor you write apps:

* in pure JavaScript
* that send data over the wire, rather than HTML
* using your choice of popular open-source libraries

Documentation is available at http://docs.meteor.com/.

Try the getting started [tutorial](https://www.meteor.com/try).

## Install

Install required packages:

```bash
sudo pkg install bash ca_root_nss curl expat gettext-runtime git-lite gmake indexinfo libevent2 libffi mongodb node npm pcre perl5 python2 python27 snappy v8
```

Install Meteor:

```bash
git clone git://github.com/yonas/meteor-freebsd.git
sudo mv meteor-freebsd /usr/local/share/meteor
sudo ln -s /usr/local/share/meteor/meteor /usr/local/bin/meteor
```

## Create an app
```bash
meteor create myapp
cd myapp
```

You'll then be able to read the docs locally in your browser at
`http://localhost:3000/`.

Note that if you run Meteor from a git checkout, you cannot pin apps to specific
Meteor releases or run using different Meteor releases using `--release`.


## Developer Resources

Building an application with Meteor?

* Announcement list: sign up at http://www.meteor.com/
* Ask a question: http://stackoverflow.com/questions/tagged/meteor
* Discussion forums: https://forums.meteor.com/

Interested in contributing to Meteor?

* Issue tracker: https://github.com/meteor/meteor/issues
* Contribution guidelines: https://github.com/meteor/meteor/tree/devel/Contributing.md

We are hiring!  Visit https://www.meteor.com/jobs to
learn more about working full-time on the Meteor project.
